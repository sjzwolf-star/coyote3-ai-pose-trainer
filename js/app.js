/**
 * 主应用控制器
 * 负责导航、事件绑定、UI 更新、模块协调
 */

/**
 * 以 cover 方式（等比缩放、居中裁剪）把视频/图片绘制到目标画布
 */
function drawCover(ctx, source, srcW, srcH, dstW, dstH) {
  if (!srcW || !srcH) { ctx.drawImage(source, 0, 0, dstW, dstH); return; }
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;
  let sw, sh;
  if (srcRatio > dstRatio) {
    sh = srcH;
    sw = sh * dstRatio;
  } else {
    sw = srcW;
    sh = sw / dstRatio;
  }
  ctx.drawImage(source, (srcW - sw) / 2, (srcH - sh) / 2, sw, sh, 0, 0, dstW, dstH);
}

const App = {
  settings: null,
  currentScreen: 'home',
  isTraining: false,

  // ==================== 初始化 ====================

  async init() {
    // 等待所有模块加载
    await this._waitForModules();

    // 初始化各模块
    AudioModule.init();

    // 加载设置
    await Store.init();
    this.settings = Store.getSettings();
    this._applySettings();

    // 设置安全层监听
    SafetyLayer.setupEventListeners();
    SafetyLayer.onLock = (reason, desc) => this._onSafetyLock(reason, desc);
    SafetyLayer.onUnlock = () => this._onSafetyUnlock();

    // 设置 BLE 回调
    CoyoteBLE.onStatusChange = (status) => this._onBleStatus(status);
    CoyoteBLE.onStrengthUpdate = (data) => this._onBleStrength(data);

    // 设置姿态检测回调
    PoseDetection.onPoseResult = (result) => this._onPoseResult(result);

    // 设置状态机回调
    StateMachine.onStateChange = (info) => this._onStateChange(info);
    StateMachine.onTick = (info) => this._onStateTick(info);
    StateMachine.onSimulatedEvent = (event) => this._onSimulatedEvent(event);
    StateMachine.onSafetyLock = (reason) => SafetyLayer.lock('状态机锁定', reason);

    // 绑定 UI 事件
    this._bindEvents();

    // 首次使用说明
    if (!this.settings.ackIntro) {
      document.getElementById('introModal').classList.add('show');
    } else {
      document.getElementById('introModal').classList.remove('show');
    }

    // 加载今日训练分钟数
    this._loadTodayMinutes();
  },

  async _waitForModules() {
    // 等待 MediaPipe 加载
    let tries = 0;
    while (typeof vision === 'undefined' && tries < 50) {
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
  },

  // ==================== 导航 ====================

  show(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(screenId);
    if (el) el.classList.add('active');
    this.currentScreen = screenId;
    scrollTo(0, 0);

    // 停止摄像头（除非在训练或准备页）
    if (screenId !== 'train' && screenId !== 'prepare' && screenId !== 'modeling') {
      PoseDetection.stopCamera();
    }

    // 从建模页返回训练页时，把绘制目标恢复为骨架画布
    if (screenId === 'train' && PoseDetection.cameraStream) {
      PoseDetection.canvasEl = document.getElementById('skeleton');
      PoseDetection.ctx = PoseDetection.canvasEl.getContext('2d');
      PoseDetection._trainCanvas = PoseDetection.canvasEl;
      PoseDetection._layoutViewport();
    }
  },

  // ==================== 事件绑定 ====================

  _bindEvents() {
    // 导航
    document.getElementById('navHome').onclick = () => this.show('home');
    document.getElementById('navTrain').onclick = () => this.show('train');
    document.getElementById('btnQuickTrain').onclick = () => this._quickTrain();
    document.getElementById('navPlan').onclick = () => this.show('plan');
    document.getElementById('navPoses').onclick = () => this.show('poses');
    document.getElementById('navHistory').onclick = () => this._showHistory();
    document.getElementById('navDevice').onclick = () => this.show('device');
    document.getElementById('navWaveform').onclick = () => this.show('waveform');
    document.getElementById('navSettings').onclick = () => this.show('settings');

    // STOP
    document.getElementById('btnStop').onclick = () => this._emergencyStop();
    document.getElementById('btnAckStop').onclick = () => {
      document.getElementById('stopModal').classList.remove('show');
      this.show('home');
    };

    // 安全锁定确认
    document.getElementById('btnAckSafety').onclick = () => {
      document.getElementById('safetyModal').classList.remove('show');
      SafetyLayer.unlock();
      this.show('home');
    };

    // 首次说明
    document.getElementById('btnAckIntro').onclick = () => {
      document.getElementById('introModal').classList.remove('show');
      this.settings.ackIntro = true;
      Store.saveSettings(this.settings);
    };

    // 训练准备
    document.getElementById('btnStartTraining').onclick = () => this._startTraining();

    // 演示控制
    document.getElementById('btnDeviate').onclick = () => this._toggleDeviation();

    // 设备连接
    document.getElementById('btnScanDevice').onclick = () => this._scanAndConnect();
    document.getElementById('btnDisconnect').onclick = () => CoyoteBLE.disconnect();
    document.getElementById('btnZeroOutput').onclick = () => this._zeroOutput();

    // 手动控制
    const sliderA = document.getElementById('sliderA');
    const sliderB = document.getElementById('sliderB');
    sliderA.oninput = () => this._onManualSlider('A', sliderA.value);
    sliderB.oninput = () => this._onManualSlider('B', sliderB.value);
    document.getElementById('btnAInc').onclick = () => this._adjustManual('A', 1);
    document.getElementById('btnADec').onclick = () => this._adjustManual('A', -1);
    document.getElementById('btnBInc').onclick = () => this._adjustManual('B', 1);
    document.getElementById('btnBDec').onclick = () => this._adjustManual('B', -1);

    // 姿态库
    document.querySelectorAll('.pose[data-pose]').forEach(el => {
      el.onclick = () => {
        const poseId = el.dataset.pose;
        if (poseId === 'new') {
          this.show('modeling');
        } else {
          this._selectPose(poseId);
        }
      };
    });

    // 图片建模
    document.getElementById('btnImportImage').onclick = () => this.show('modeling');
    document.getElementById('btnPickImage').onclick = () => document.getElementById('fileInput').click();
    document.getElementById('btnCaptureFrame').onclick = () => this._captureFrame();
    document.getElementById('fileInput').onchange = (e) => this._onImageSelected(e);
    document.getElementById('btnSaveModel').onclick = () => this._saveModel();

    // 训练计划
    document.getElementById('btnAddSegment').onclick = () => alert('已添加一个动作段（原型示意）');

    // 波形预览
    document.getElementById('wfFreq').oninput = (e) => {
      document.getElementById('wfFreqVal').textContent = e.target.value;
      this._drawWaveformPreview();
    };
    document.getElementById('wfIntensity').oninput = (e) => {
      document.getElementById('wfIntensityVal').textContent = e.target.value;
      this._drawWaveformPreview();
    };
    document.querySelectorAll('.pose[data-waveform]').forEach(el => {
      el.onclick = () => this._selectWaveform(el.dataset.waveform);
    });

    // 设置
    ['setThreshold','setCooldown','setALimit','setBLimit','setMaxTime'].forEach(id => {
      document.getElementById(id).onchange = () => this._saveSettings();
    });
    document.getElementById('setVoice').onchange = () => this._saveSettings();
    document.getElementById('setVolume').oninput = () => {
      document.getElementById('setVolume'); // no live display needed
    };
    document.getElementById('setVolume').onchange = () => this._saveSettings();
    document.getElementById('setSaveVideo').onchange = () => this._saveSettings();
    document.getElementById('setSaveData').onchange = () => this._saveSettings();
    document.getElementById('btnTestVoice').onclick = () => {
      AudioModule.speak('姿态正确，继续保持');
    };
  },

  // ==================== 设置 ====================

  _applySettings() {
    document.getElementById('setThreshold').value = this.settings.threshold;
    document.getElementById('setCooldown').value = this.settings.cooldown;
    document.getElementById('setALimit').value = this.settings.aLimit;
    document.getElementById('setBLimit').value = this.settings.bLimit;
    document.getElementById('setMaxTime').value = this.settings.maxTime;
    document.getElementById('setVoice').value = this.settings.voiceStyle;
    document.getElementById('setVolume').value = this.settings.voiceVolume;
    document.getElementById('setSaveVideo').checked = this.settings.saveVideo;
    document.getElementById('setSaveData').checked = this.settings.saveData;

    AudioModule.setStyle(this.settings.voiceStyle);
    AudioModule.setVolume(this.settings.voiceVolume);
  },

  _saveSettings() {
    this.settings.threshold = parseInt(document.getElementById('setThreshold').value);
    this.settings.cooldown = parseInt(document.getElementById('setCooldown').value);
    this.settings.aLimit = parseInt(document.getElementById('setALimit').value);
    this.settings.bLimit = parseInt(document.getElementById('setBLimit').value);
    this.settings.maxTime = parseInt(document.getElementById('setMaxTime').value);
    this.settings.voiceStyle = document.getElementById('setVoice').value;
    this.settings.voiceVolume = parseInt(document.getElementById('setVolume').value);
    this.settings.saveVideo = document.getElementById('setSaveVideo').checked;
    this.settings.saveData = document.getElementById('setSaveData').checked;

    Store.saveSettings(this.settings);
    AudioModule.setStyle(this.settings.voiceStyle);
    AudioModule.setVolume(this.settings.voiceVolume);
    StateMachine.cooldownDuration = this.settings.cooldown;
  },

  // ==================== 训练流程 ====================

  async _quickTrain() {
    // 默认使用四肢支撑
    const pose = PoseDetection.getPresetPose('quadSupport');
    if (pose) {
      PoseDetection.setTargetPose(pose);
      document.getElementById('trainPoseName').textContent = pose.name;
      document.getElementById('trainThreshold').textContent = `目标匹配度 ≥ ${pose.threshold}%`;
    }

    // 进入准备页
    this.show('prepare');
    await this._startCamera();
    this._startChecks();
  },

  async _startCamera() {
    try {
      await PoseDetection.startCamera();
      this._updateStatusChip('chipCamera', true, '摄像头就绪');
    } catch (e) {
      this._updateStatusChip('chipCamera', false, '摄像头权限被拒');
      alert('无法启动摄像头：' + e.message);
    }
  },

  _startChecks() {
    // 重置检查项
    ['checkCamera','checkFraming','checkDistance','checkSingle','checkCalibration'].forEach(id => {
      document.getElementById(id).classList.remove('passed');
      document.getElementById(id).querySelector('.check-icon').textContent = '○';
    });

    // 摄像头检查
    if (PoseDetection.cameraStream) {
      this._passCheck('checkCamera');
    }

    // 其他检查在姿态回调中更新
    this._checkInterval = setInterval(() => this._runChecks(), 500);
  },

  _passCheck(id) {
    const el = document.getElementById(id);
    if (!el.classList.contains('passed')) {
      el.classList.add('passed');
      el.querySelector('.check-icon').textContent = '✓';
    }
    this._checkAllPassed();
  },

  _checkAllPassed() {
    const allPassed = ['checkCamera','checkFraming','checkDistance','checkSingle','checkCalibration']
      .every(id => document.getElementById(id).classList.contains('passed'));
    const btn = document.getElementById('btnStartTraining');
    btn.disabled = !allPassed;
    if (allPassed) {
      btn.textContent = '开始训练';
      btn.classList.add('pulse');
    }
  },

  _runChecks() {
    if (this.currentScreen !== 'prepare') {
      clearInterval(this._checkInterval);
      return;
    }
    if (!PoseDetection.results || !PoseDetection.results.landmarks) return;

    const pose = PoseDetection.results.landmarks[0];
    if (!pose) return;

    // 单人检查
    if (PoseDetection.results.landmarks.length === 1) {
      this._passCheck('checkSingle');
    }

    // 取景检查
    const framing = PoseDetection.checkFraming(pose);
    if (framing.pass) {
      this._passCheck('checkFraming');
      this._passCheck('checkDistance');
    }

    // 校准（保持站姿2秒）
    if (framing.pass) {
      if (!this._calibrationStart) this._calibrationStart = Date.now();
      if (Date.now() - this._calibrationStart > 2000) {
        this._passCheck('checkCalibration');
        clearInterval(this._checkInterval);
      }
    } else {
      this._calibrationStart = null;
    }
  },

  _startTraining() {
    this.isTraining = true;
    StateMachine.startTraining(this.settings.threshold || 85);
    StateMachine.enterNormal();
    SafetyLayer.startTrainingTimer(this.settings.maxTime || 60);

    // 设置 BLE 波形为空闲
    if (CoyoteBLE.connected) {
      const idle = CoyoteBLE.generateWaveform('idle');
      CoyoteBLE.setWaveformA(idle.freq, idle.intensity);
      CoyoteBLE.setWaveformB(idle.freq, idle.intensity);
    }

    this.show('train');
    AudioModule.speak('训练开始，请保持正确姿态');
  },

  // ==================== 姿态回调 ====================

  _onPoseResult(result) {
    // 准备页检查
    if (this.currentScreen === 'prepare') {
      return; // 检查在 _runChecks 中处理
    }

    if (this.currentScreen !== 'train' || !this.isTraining) return;

    if (SafetyLayer.locked) return;

    // 人体丢失时清除旧骨架，避免残留在实景上
    if (!result.detected) {
      PoseDetection.drawSkeleton(null);
      StateMachine.updateMatch(0, false);
      return;
    }

    // 安全检查
    const safetyCheck = SafetyLayer.checkPoseResult(result);
    if (!safetyCheck.allow && safetyCheck.safe) {
      // 人体丢失等，不视为违规
      PoseDetection.drawSkeleton(null);
      StateMachine.updateMatch(0, false);
      return;
    }

    // 更新匹配度
    StateMachine.updateMatch(result.matchScore || 0, result.detected);

    // 绘制骨架
    const info = StateMachine.getStateInfo();
    PoseDetection.drawSkeleton(result.landmarks, {
      color: info.isDeviating ? '#ffb547' : '#54e58a',
      matched: !info.isDeviating,
      deviation: info.isDeviating,
    });

    // 更新 UI
    document.getElementById('match').textContent = (result.matchScore || 0) + '%';
    document.getElementById('timer').textContent = String(info.deviationSeconds).padStart(2, '0');
    document.getElementById('phase').textContent = info.label;
  },

  // ==================== 状态机回调 ====================

  _onStateChange(info) {
    document.getElementById('phase').textContent = info.label;

    const cueEl = document.getElementById('cue');
    const matchEl = document.getElementById('match');

    switch (info.state) {
      case 'normal':
        cueEl.innerHTML = '<b>姿态正确</b><div class="sub">保持当前姿态，继续训练</div>';
        matchEl.style.color = 'var(--green)';
        break;
      case 'deviation_0_5':
        cueEl.innerHTML = '<b>姿态偏离</b><div class="sub">请调整到目标姿态</div>';
        matchEl.style.color = 'var(--orange)';
        break;
      case 'reminder_5_10':
        cueEl.innerHTML = '<b>请纠正姿态</b><div class="sub">第一次语音提醒</div>';
        matchEl.style.color = 'var(--orange)';
        AudioModule.speakReminder(5);
        AudioModule.playBeep(880, 200);
        break;
      case 'warning_10_15':
        cueEl.innerHTML = '<b>姿态仍未恢复</b><div class="sub">第二次语音警告，请在倒计时结束前调整</div>';
        matchEl.style.color = 'var(--red)';
        AudioModule.speakReminder(10);
        AudioModule.playWarning();
        break;
    }
  },

  _onStateTick(info) {
    document.getElementById('timer').textContent = String(info.deviationSeconds).padStart(2, '0');
  },

  _onSimulatedEvent(event) {
    if (event.type === 'simulated_trigger') {
      AudioModule.playTrigger();
      AudioModule.speakTrigger();

      // 模拟 A/B 通道动画
      this._animateSimulatedChannels();

      const cueEl = document.getElementById('cue');
      cueEl.innerHTML = '<b>模拟触发</b><div class="sub">震动、声音和动画；实际输出保持为 0</div>';
    }

    // 保存事件
    if (this.settings.saveData) {
      Store.saveSafetyEvent(event);
    }
  },

  _animateSimulatedChannels() {
    // 模拟通道条动画（不发送实际指令）
    const aBar = document.getElementById('aBar');
    const bBar = document.getElementById('bBar');
    aBar.style.width = '60%';
    bBar.style.width = '60%';
    setTimeout(() => {
      aBar.style.width = '0%';
      bBar.style.width = '0%';
    }, 500);
  },

  // ==================== 演示控制 ====================

  _toggleDeviation() {
    if (!this.isTraining) {
      alert('请先开始训练');
      return;
    }
    const btn = document.getElementById('btnDeviate');
    const isDeviating = btn.textContent === '恢复正确姿态';

    if (!isDeviating) {
      // 模拟偏离
      StateMachine.simulateDeviation(true);
      btn.textContent = '恢复正确姿态';
    } else {
      // 恢复
      StateMachine.simulateDeviation(false);
      btn.textContent = '模拟姿态偏离';
      document.getElementById('match').textContent = '92%';
      document.getElementById('phase').textContent = '正常';
      document.getElementById('cue').innerHTML = '<b>姿态正确</b><div class="sub">保持背部稳定，继续当前姿态</div>';
      PoseDetection.drawSkeleton(null, { color: '#54e58a' });
    }
  },

  // ==================== 紧急停止 ====================

  _emergencyStop() {
    StateMachine.reset();
    SafetyLayer.stopTrainingTimer();
    AudioModule.stopVibrate();
    AudioModule.playBeep(220, 300, 'square');

    if (CoyoteBLE.connected) {
      CoyoteBLE.emergencyStop();
    }

    // 显示模态框
    document.getElementById('stopModal').classList.add('show');
    this.isTraining = false;
  },

  _onSafetyLock(reason, desc) {
    document.getElementById('safetyReason').textContent = reason;
    document.getElementById('safetyDesc').textContent = desc || reason;
    document.getElementById('safetyModal').classList.add('show');
    this.isTraining = false;
    AudioModule.playWarning();
  },

  _onSafetyUnlock() {
    document.getElementById('safetyModal').classList.remove('show');
  },

  // ==================== BLE 设备 ====================

  async _scanAndConnect() {
    try {
      const device = await CoyoteBLE.scan();
      if (!device) return;

      document.getElementById('deviceConnStatus').textContent = '连接中...';
      await CoyoteBLE.connect(device);

      // 记住设备
      Store.rememberDevice(device.id, device.name);

      // 更新 UI
      document.getElementById('deviceConnStatus').textContent = '已连接';
      document.getElementById('deviceConnStatus').style.color = 'var(--green)';
      document.getElementById('deviceInfo').style.display = 'block';
      document.getElementById('deviceName').textContent = device.name || '未知';
      document.getElementById('deviceId').textContent = device.id.substring(0, 16) + '...';
      document.getElementById('btnDisconnect').style.display = 'block';
      document.getElementById('btnScanDevice').textContent = '重新扫描连接';

      // 设置通道上限
      await CoyoteBLE.sendBF(this.settings.aLimit, this.settings.bLimit, 100, 100, 100, 100);

      this._updateStatusChip('chipBle', true, 'BLE 已连接');
    } catch (e) {
      document.getElementById('deviceConnStatus').textContent = '连接失败';
      alert('连接失败：' + e.message);
    }
  },

  _onBleStatus(status) {
    if (status.connected) {
      this._updateStatusChip('chipBle', true, `BLE ${status.deviceName || '已连接'}`);
    } else {
      this._updateStatusChip('chipBle', false, 'BLE 未连接');
      document.getElementById('deviceConnStatus').textContent = '未连接';
      document.getElementById('deviceConnStatus').style.color = '';
      document.getElementById('deviceInfo').style.display = 'none';
      document.getElementById('btnDisconnect').style.display = 'none';

      // 训练中断连 → 安全锁定
      if (this.isTraining) {
        SafetyLayer.lock('BLE 断连', '蓝牙连接已断开，训练已自动停止');
      }
    }
  },

  _onBleStrength(data) {
    // 更新设备页面
    document.getElementById('devAStrength').textContent = data.a.strength;
    document.getElementById('devBStrength').textContent = data.b.strength;
    document.getElementById('devALimit').textContent = data.a.ceiling;
    document.getElementById('devBLimit').textContent = data.b.ceiling;
    document.getElementById('devABar').style.width = (data.a.strength / 200 * 100) + '%';
    document.getElementById('devBBar').style.width = (data.b.strength / 200 * 100) + '%';

    // 更新顶部状态栏
    document.getElementById('chipChannels').textContent = `A ${data.a.strength} · B ${data.b.strength}`;
  },

  _onManualSlider(channel, value) {
    const val = parseInt(value);
    document.getElementById('manual' + channel + 'Val').textContent = val;
    if (channel === 'A') CoyoteBLE.setStrengthA(val);
    else CoyoteBLE.setStrengthB(val);
  },

  _adjustManual(channel, delta) {
    const sliderId = 'slider' + channel;
    const slider = document.getElementById(sliderId);
    let val = parseInt(slider.value) + delta;
    val = Math.max(0, Math.min(200, val));
    slider.value = val;
    this._onManualSlider(channel, val);
  },

  _zeroOutput() {
    CoyoteBLE.setStrengthA(0);
    CoyoteBLE.setStrengthB(0);
    document.getElementById('sliderA').value = 0;
    document.getElementById('sliderB').value = 0;
    document.getElementById('manualAVal').textContent = '0';
    document.getElementById('manualBVal').textContent = '0';
    AudioModule.playBeep(440, 200);
  },

  // ==================== 图片建模 ====================

  _onImageSelected(event) {
    const file = event.target.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = async () => {
      await this._processModelingImage(img);
    };
    img.src = URL.createObjectURL(file);
    event.target.value = '';
  },

  async _captureFrame() {
    if (!PoseDetection.cameraStream) {
      try { await PoseDetection.startCamera(); } catch(e) { alert('无法启动摄像头'); return; }
    }

    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('modelCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 390;
    canvas.height = 390;
    // 与训练画面一致使用 cover 方式取帧，骨架才能对齐
    drawCover(ctx, video, video.videoWidth || 720, video.videoHeight || 1280, 390, 390);

    // 创建 Image 对象用于检测
    const img = new Image();
    img.onload = async () => await this._processModelingImage(img);
    img.src = canvas.toDataURL();
  },

  async _processModelingImage(img) {
    const canvas = document.getElementById('modelCanvas');
    const ctx = canvas.getContext('2d');

    // cover 方式绘制图片（等比缩放居中裁剪），与骨架映射保持一致
    canvas.width = 390;
    canvas.height = 390;
    drawCover(ctx, img, img.width, img.height, 390, 390);

    // 检测姿态
    try {
      const result = await PoseDetection.detectImage(img);
      if (!result.detected) {
        document.getElementById('modelingResult').style.display = 'block';
        document.getElementById('modelAngles').innerHTML = '<span class="warning">未检测到人体姿态</span>';
        return;
      }

      // 绘制骨架
      PoseDetection.canvasEl = canvas;
      PoseDetection.ctx = ctx;
      PoseDetection.drawSkeleton(result.landmarks, { color: '#40d8d0' });

      // 显示角度
      const angleList = Object.entries(result.angles)
        .map(([name, angle]) => `${name}: ${angle}°`)
        .join('<br>');
      document.getElementById('modelAngles').innerHTML = angleList;
      document.getElementById('modelingResult').style.display = 'block';
      document.getElementById('modelName').value = '自定义姿态';

      // 保存当前检测结果供保存使用
      this._currentModelingResult = result;
    } catch (e) {
      alert('姿态检测失败：' + e.message);
    }
  },

  async _saveModel() {
    if (!this._currentModelingResult) {
      alert('请先导入或拍摄图片');
      return;
    }

    const template = {
      name: document.getElementById('modelName').value || '自定义姿态',
      threshold: parseInt(document.getElementById('modelThreshold').value) || 85,
      angles: this._currentModelingResult.angles,
      tolerance: {},
      voicePrompt: `请保持${document.getElementById('modelName').value || '姿态'}`,
      source: 'image',
    };

    // 设置默认容差
    for (const name of Object.keys(template.angles)) {
      template.tolerance[name] = 15;
    }

    await Store.savePoseTemplate(template);
    alert('姿态模板已保存');
    this.show('poses');
  },

  // ==================== 波形 ====================

  _selectWaveform(type) {
    const wf = CoyoteBLE.generateWaveform(type);
    document.getElementById('wfFreq').value = wf.freq[0];
    document.getElementById('wfIntensity').value = wf.intensity[1];
    document.getElementById('wfFreqVal').textContent = wf.freq[0];
    document.getElementById('wfIntensityVal').textContent = wf.intensity[1];
    this._drawWaveformPreview();

    if (CoyoteBLE.connected) {
      CoyoteBLE.setWaveformA(wf.freq, wf.intensity);
      CoyoteBLE.setWaveformB(wf.freq, wf.intensity);
    }
  },

  _drawWaveformPreview() {
    const canvas = document.getElementById('waveformPreview');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const freq = parseInt(document.getElementById('wfFreq').value);
    const intensity = parseInt(document.getElementById('wfIntensity').value);
    const amp = (intensity / 100) * (h / 2 - 5);

    ctx.strokeStyle = '#40d8d0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 2 * (freq / 10)) * amp * Math.sin((x / w) * Math.PI);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },

  // ==================== 历史记录 ====================

  async _showHistory() {
    this.show('history');
    const sessions = await Store.getAllSessions();
    const list = document.getElementById('historyList');

    if (sessions.length === 0) {
      list.innerHTML = '<p class="sub" style="text-align:center;padding:20px 0">暂无训练记录</p>';
      return;
    }

    list.innerHTML = sessions.map(s => `
      <div class="step" style="margin-bottom:8px">
        <em>${new Date(s.savedAt).toLocaleString('zh-CN')}</em>
        <h2>训练时长 ${s.correctDuration || 0} 秒</h2>
        <p class="sub">偏离 ${s.deviationCount || 0} 次 · 纠偏 ${s.correctionCount || 0} 次 · 模拟事件 ${s.simulatedEvents?.length || 0} 个</p>
        <p class="sub">停止原因: ${s.stopReason || '正常结束'}</p>
      </div>
    `).join('');
  },

  // ==================== 工具方法 ====================

  _updateStatusChip(chipId, ok, text) {
    const chip = document.getElementById(chipId);
    chip.textContent = (ok ? '● ' : '○ ') + text;
    chip.className = 'chip' + (ok ? ' ok' : '');
  },

  async _loadTodayMinutes() {
    const sessions = await Store.getAllSessions();
    const today = new Date().setHours(0, 0, 0, 0);
    const todaySessions = sessions.filter(s => (s.savedAt || 0) >= today);
    const total = todaySessions.reduce((sum, s) => sum + (s.correctDuration || 0), 0);
    document.getElementById('todayMinutes').innerHTML = Math.round(total / 60) + '<small style="font-size:15px;color:var(--muted)"> 分钟</small>';
  },

  _selectPose(poseId) {
    const pose = PoseDetection.getPresetPose(poseId);
    if (!pose) return;
    PoseDetection.setTargetPose(pose);
    document.getElementById('trainPoseName').textContent = pose.name;
    document.getElementById('trainThreshold').textContent = `目标匹配度 ≥ ${pose.threshold}%`;
    alert(`已选择姿态: ${pose.name}`);
    this.show('prepare');
  },
};

// 启动应用
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
