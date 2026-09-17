/**
 * 姿态检测模块
 * 使用 MediaPipe Tasks Vision PoseLandmarker
 * 支持实时摄像头流和图片导入
 */
const PoseDetection = {
  landmarker: null,
  runningMode: 'IMAGE',
  cameraStream: null,
  videoEl: null,
  canvasEl: null,
  ctx: null,
  rafId: null,
  lastVideoTime: -1,
  results: null,

  // 实景对齐相关
  _trainCanvas: null,
  _srcW: 0,
  _srcH: 0,
  _dpr: 1,
  _mirrored: true,
  facingMode: 'user', // user=前置（镜像） environment=后置（不镜像）
  _resizeHandler: null,

  // 缩放（景深/焦距）相关
  zoom: 1,             // 当前 zoom 倍数（1=广角，>1=放大）
  zoomMin: 1,
  zoomMax: 4,          // 大多数手机硬件支持 1-4x
  _track: null,        // MediaStreamTrack，用于 applyConstraints
  _supportsZoomTrack: null,  // null=未知 true/false=已探测
  _digitalScale: 1,    // 硬件不支持时的 CSS 数字放大倍数

  // 回调
  onPoseResult: null,

  // PoseLandmarker 33个关键点索引
  // 0: nose, 11-12: shoulders, 13-14: elbows, 15-16: wrists,
  // 23-24: hips, 25-26: knees, 27-28: ankles
  KEYPOINT_INDICES: {
    nose: 0, leftShoulder: 11, rightShoulder: 12,
    leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
    leftHip: 23, rightHip: 24,
    leftKnee: 25, rightKnee: 26,
    leftAnkle: 27, rightAnkle: 28,
  },

  // 骨架连接
  CONNECTIONS: [
    [11,12],[11,13],[13,15],[12,14],[14,16], // 上半身
    [11,23],[12,24],[23,24], // 躯干
    [23,25],[25,27],[24,26],[26,28], // 下半身
    [0,11],[0,12], // 头部
  ],

  // 关节角度计算所需的三元组
  ANGLE_TRIPLETS: [
    { name: 'leftElbow',   a: 11, b: 13, c: 15 },
    { name: 'rightElbow',  a: 12, b: 14, c: 16 },
    { name: 'leftShoulder',a: 13, b: 11, c: 23 },
    { name: 'rightShoulder',a:14, b: 12, c: 24 },
    { name: 'leftHip',     a: 11, b: 23, c: 25 },
    { name: 'rightHip',    a: 12, b: 24, c: 26 },
    { name: 'leftKnee',    a: 23, b: 25, c: 27 },
    { name: 'rightKnee',   a: 24, b: 26, c: 28 },
  ],

  // ==================== 初始化 ====================

  async init() {
    // 等待本地 MediaPipe 模块动态加载完成（最多20秒）
    if (typeof vision === 'undefined') {
      const start = Date.now();
      while (typeof vision === 'undefined' && Date.now() - start < 20000) {
        if (window.__visionError) {
          throw new Error('MediaPipe 库加载失败: ' + window.__visionError);
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (typeof vision === 'undefined') {
      throw new Error('MediaPipe Tasks Vision 库加载超时，请检查网络连接后刷新页面。');
    }

    const { PoseLandmarker, FilesetResolver } = vision;

    // 使用本地 wasm 与本地模型，国内网络无需访问外部 CDN
    const filesetResolver = await FilesetResolver.forVisionTasks('lib/mediapipe/wasm');

    this.landmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: 'lib/models/pose_landmarker_lite.task',
        delegate: 'CPU', // 手机端先用CPU，后续可改GPU
      },
      runningMode: 'IMAGE', // 初始模式，后续切换为VIDEO
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    return true;
  },

  // ==================== 摄像头流 ====================

  async startCamera() {
    if (!this.landmarker) await this.init();

    this.videoEl = document.getElementById('cameraVideo');
    if (!this.videoEl) throw new Error('找不到视频元素');

    this.cameraStream = await this._getStream(this.facingMode);

    // 保存 track 引用供 zoom 控制
    this._track = this.cameraStream.getVideoTracks()[0] || null;
    this._supportsZoomTrack = null;  // 重置探测状态，新流重新探测

    this.videoEl.srcObject = this.cameraStream;
    await this.videoEl.play();

    // 切换到 VIDEO 模式
    this.runningMode = 'VIDEO';
    this.landmarker.setOptions({ runningMode: 'VIDEO' });

    this.canvasEl = document.getElementById('skeleton');
    this.ctx = this.canvasEl.getContext('2d');

    // 显示摄像头实景并应用对应镜像（前置镜像/后置不镜像）
    this.videoEl.style.display = 'block';

    // 等待拿到真实分辨率，避免骨架错位
    if (this.videoEl.readyState < 1) {
      await new Promise(res => this.videoEl.addEventListener('loadedmetadata', res, { once: true }));
    }
    this._srcW = this.videoEl.videoWidth || 720;
    this._srcH = this.videoEl.videoHeight || 1280;
    this._applyMirror();

    // canvas 内部分辨率按实际渲染尺寸 × DPR，保证清晰且与视频 cover 裁剪对齐
    this._trainCanvas = this.canvasEl;
    this._layoutViewport();
    if (!this._resizeHandler) {
      this._resizeHandler = () => this._layoutViewport();
      window.addEventListener('resize', this._resizeHandler);
      window.addEventListener('orientationchange', this._resizeHandler);
    }

    // 开始检测循环
    this._detectLoop();

    return true;
  },

  /**
   * 申请指定朝向的摄像头；exact 失败时降级 ideal，兼容单摄像头设备
   * 优先广角：高分辨率让传感器原生广角覆盖更多视野
   */
  async _getStream(mode) {
    const constraints = (exact) => ({
      video: {
        facingMode: exact ? { exact: mode } : mode,
        width:  { ideal: 1920 },   // 偏好高分辨率 → 更接近广角原生视野
        height: { ideal: 1080 },
        aspectRatio: { ideal: 16 / 9 },  // 广角常见比例
      },
      audio: false,
    });
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(true));
    } catch (e) {
      try { return await navigator.mediaDevices.getUserMedia(constraints(false)); }
      catch { // 再退一档较低分辨率
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: exact ? { exact: mode } : mode, width: { ideal: 720 }, height: { ideal: 1280 } },
          audio: false,
        });
      }
    }
  },

  /**
   * 探测当前 track 是否支持 zoom 约束；只测一次
   */
  _detectZoomSupport() {
    if (this._supportsZoomTrack !== null) return;
    if (!this._track || typeof this._track.getCapabilities !== 'function') {
      this._supportsZoomTrack = false;
      return;
    }
    try {
      const caps = this._track.getCapabilities();
      this._supportsZoomTrack = !!(caps && caps.zoom);
      if (this._supportsZoomTrack) {
        // 同步真实硬件上下限
        if (caps.zoom.min != null) this.zoomMin = caps.zoom.min;
        if (caps.zoom.max != null) this.zoomMax = Math.max(caps.zoom.max, this.zoomMax);
      }
    } catch { this._supportsZoomTrack = false; }
  },

  /**
   * 设置 zoom 倍数（1=广角，>1=放大）；硬件不支持时用 CSS transform 数字放大作兜底
   */
  async setZoom(z) {
    this.zoom = Math.max(this.zoomMin, Math.min(this.zoomMax, Number(z) || 1));
    this._detectZoomSupport();

    // 硬件 zoom
    if (this._supportsZoomTrack && this._track) {
      try {
        await this._track.applyConstraints({ advanced: [{ zoom: this.zoom }] });
        this._digitalScale = 1;  // 硬件生效，不需要 CSS 数字放大
        this._applyDigitalScale();
        this._notifyZoom();
        return;
      } catch (e) { /* 部分机型会拒绝；落到数字放大 */ }
    }

    // 数字放大兜底：用 CSS transform 把视频等比放大，骨架坐标已被 _mapPt 处理 cover 裁剪
    // 需要同步给骨架画布也做相同的 scale + center 位移
    this._digitalScale = this.zoom;
    this._applyDigitalScale();
    this._notifyZoom();
  },

  /**
   * 把当前数字放大应用到 video 和 canvas 的 CSS transform
   * （硬件 zoom 生效时 _digitalScale=1，等价于不做 CSS 放大）
   */
  _applyDigitalScale() {
    if (!this.videoEl) return;
    const s = this._digitalScale;
    // 用 transform-origin 中心等比放大，镜像和缩放合并写
    const mirror = this._mirrored ? 'scaleX(-1)' : 'scaleX(1)';
    this.videoEl.style.transformOrigin = 'center center';
    this.videoEl.style.transform = `${mirror} scale(${s})`;

    // 骨架 canvas 同步等比放大（保持骨架与实景对齐）
    if (this.canvasEl && this.canvasEl === this._trainCanvas) {
      this.canvasEl.style.transformOrigin = 'center center';
      // 骨架 canvas 默认无镜像，仅缩放
      this.canvasEl.style.transform = `scale(${s})`;
    }
    // 更新 UI 徽标
    const badge = document.getElementById('zoomBadge');
    if (badge) badge.textContent = `${this.zoom.toFixed(1)}×`;
  },

  _notifyZoom() {
    if (this.onZoomChange) this.onZoomChange(this.zoom);
  },

  /**
   * 根据当前摄像头朝向同步镜像状态（前置镜像，后置不镜像）
   */
  _applyMirror() {
    this._mirrored = this.facingMode === 'user';
    if (this.videoEl) {
      this.videoEl.classList.toggle('mirrored', this._mirrored);
    }
  },

  /**
   * 运行中切换前后摄像头：先开新流、成功后再释放旧流，避免切换失败黑屏
   */
  async switchCamera() {
    if (!this.landmarker) await this.init();
    this.videoEl = document.getElementById('cameraVideo');
    if (!this.videoEl) throw new Error('找不到视频元素');

    const next = this.facingMode === 'user' ? 'environment' : 'user';
    const btn = document.getElementById('btnFlipCamera');
    if (btn) btn.disabled = true;
    try {
      const newStream = await this._getStream(next);

      // 释放旧流
      if (this.cameraStream) {
        this.cameraStream.getTracks().forEach(t => t.stop());
      }

      this.cameraStream = newStream;
      this._track = newStream.getVideoTracks()[0] || null;
      this._supportsZoomTrack = null;
      // 切换前后摄时重置 zoom，新流默认广角
      this.zoom = 1;
      this._digitalScale = 1;
      this.facingMode = next;
      this.videoEl.srcObject = newStream;
      await this.videoEl.play();
      if (this.videoEl.readyState < 1) {
        await new Promise(res => this.videoEl.addEventListener('loadedmetadata', res, { once: true }));
      }
      this._srcW = this.videoEl.videoWidth || this._srcW || 720;
      this._srcH = this.videoEl.videoHeight || this._srcH || 1280;
      this._applyMirror();
      this._applyDigitalScale();
      this._layoutViewport();

      // 新流 currentTime 归零，重置帧标记，检测循环继续
      this.lastVideoTime = -1;
      if (!this.rafId) this._detectLoop();

      return next;
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  /**
   * 按容器实际尺寸设置 canvas 分辨率（与 video 的 object-fit:cover 使用同一显示区域）
   */
  _layoutViewport() {
    if (!this.canvasEl || !this._srcW) return;
    const rect = this.canvasEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvasEl.width = Math.round(rect.width * this._dpr);
    this.canvasEl.height = Math.round(rect.height * this._dpr);
  },

  /**
   * 关键点坐标映射：MediaPipe 返回视频帧内的归一化坐标，
   * 需按 cover 方式（等比缩放+居中裁剪）换算到 canvas；前置画面镜像时同步翻转
   */
  _mapPt(lm) {
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    // 源尺寸未知时退化为直接归一化映射
    if (!this._srcW || !this._srcH) {
      return { x: lm.x * w, y: lm.y * h };
    }
    const scale = Math.max(w / this._srcW, h / this._srcH);
    const dw = this._srcW * scale;
    const dh = this._srcH * scale;
    let x = lm.x * dw - (dw - w) / 2;
    let y = lm.y * dh - (dh - h) / 2;
    if (this._mirrored && this.canvasEl === this._trainCanvas) x = w - x;
    return { x, y };
  },

  stopCamera() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(t => t.stop());
      this.cameraStream = null;
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl.style.display = 'none';
      // 清空 zoom transform，避免下次启动残留
      this.videoEl.style.transform = '';
    }
    if (this.canvasEl && this.canvasEl === this._trainCanvas) {
      this.canvasEl.style.transform = '';
    }
    this._track = null;
    this._supportsZoomTrack = null;
    this.zoom = 1;
    this._digitalScale = 1;
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      window.removeEventListener('orientationchange', this._resizeHandler);
      this._resizeHandler = null;
    }
    // 清空训练画布
    if (this.ctx && this.canvasEl === this._trainCanvas) {
      this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    }
  },

  // ==================== 检测循环 ====================

  _detectLoop() {
    if (!this.videoEl || !this.landmarker) return;

    const now = performance.now();
    if (this.videoEl.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.videoEl.currentTime;
      this.results = this.landmarker.detectForVideo(this.videoEl, now);
      this._processResult();
    }

    this.rafId = requestAnimationFrame(() => this._detectLoop());
  },

  _processResult() {
    if (!this.results || !this.onPoseResult) return;

    const pose = this.results.landmarks && this.results.landmarks[0];

    if (!pose || pose.length === 0) {
      this.onPoseResult({
        detected: false,
        personCount: 0,
        landmarks: null,
        angles: null,
        matchScore: 0,
        reason: '未检测到人体',
      });
      return;
    }

    // 计算关节角度
    const angles = this._calculateAngles(pose);

    // 计算匹配度
    const matchInfo = this._calculateMatch(pose, angles);

    this.onPoseResult({
      detected: true,
      personCount: this.results.landmarks.length,
      landmarks: pose,
      angles: angles,
      matchScore: matchInfo.score,
      maxDeviation: matchInfo.maxDeviation,
      maxDeviationName: matchInfo.maxDeviationName,
      worldLandmarks: this.results.worldLandmarks,
    });
  },

  // ==================== 关节角度计算 ====================

  _calculateAngles(landmarks) {
    const angles = {};
    for (const triplet of this.ANGLE_TRIPLETS) {
      const a = landmarks[triplet.a];
      const b = landmarks[triplet.b];
      const c = landmarks[triplet.c];
      if (a && b && c) {
        angles[triplet.name] = this._angleBetween(a, b, c);
      }
    }
    return angles;
  },

  _angleBetween(a, b, c) {
    // 计算从 b 点看 a 和 c 的夹角
    const rad = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let deg = Math.abs(rad * 180 / Math.PI);
    if (deg > 180) deg = 360 - deg;
    return Math.round(deg);
  },

  // ==================== 匹配度计算 ====================

  _targetPose: null,
  _mirrorMode: false,

  setTargetPose(poseData) {
    this._targetPose = poseData;
  },

  setMirror(enabled) {
    this._mirrorMode = enabled;
  },

  _calculateMatch(landmarks, angles) {
    if (!this._targetPose || !this._targetPose.angles) {
      return { score: 0, maxDeviation: 0, maxDeviationName: '' };
    }

    // 关节角度权重
    const weights = {
      leftElbow: 0.15, rightElbow: 0.15,
      leftShoulder: 0.1, rightShoulder: 0.1,
      leftHip: 0.15, rightHip: 0.15,
      leftKnee: 0.1, rightKnee: 0.1,
    };

    let totalWeight = 0;
    let totalScore = 0;
    let maxDeviation = 0;
    let maxDeviationName = '';
    let deviations = [];

    for (const [name, targetAngle] of Object.entries(this._targetPose.angles)) {
      const currentAngle = angles[name];
      if (currentAngle === undefined) continue;

      const weight = weights[name] || 0.05;
      const diff = Math.abs(currentAngle - targetAngle);
      const tolerance = this._targetPose.tolerance ? (this._targetPose.tolerance[name] || 15) : 15;

      // 容差内为满分，超出按比例扣分
      const score = diff <= tolerance ? 100 : Math.max(0, 100 - (diff - tolerance) * 2);

      totalScore += score * weight;
      totalWeight += weight;

      if (diff > maxDeviation) {
        maxDeviation = diff;
        maxDeviationName = name;
      }

      deviations.push({ name, diff, score });
    }

    const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

    return { score: finalScore, maxDeviation, maxDeviationName, deviations };
  },

  // ==================== 镜像处理 ====================

  _mirrorLandmarks(landmarks) {
    return landmarks.map(lm => ({
      ...lm,
      x: 1 - lm.x,
    }));
  },

  // ==================== 图片检测 ====================

  async detectImage(imageElement) {
    if (!this.landmarker) await this.init();

    // 记录源图尺寸，供 _mapPt 做与 drawImage(cover) 一致的映射
    this._srcW = imageElement.naturalWidth || imageElement.videoWidth || imageElement.width;
    this._srcH = imageElement.naturalHeight || imageElement.videoHeight || imageElement.height;

    // 确保是 IMAGE 模式
    if (this.runningMode !== 'IMAGE') {
      this.runningMode = 'IMAGE';
      this.landmarker.setOptions({ runningMode: 'IMAGE' });
    }

    const results = this.landmarker.detect(imageElement);

    if (!results.landmarks || results.landmarks.length === 0) {
      return { detected: false, landmarks: null, angles: null };
    }

    const pose = results.landmarks[0];
    const angles = this._calculateAngles(pose);

    return {
      detected: true,
      landmarks: pose,
      angles: angles,
      worldLandmarks: results.worldLandmarks,
    };
  },

  // ==================== 绘制骨架 ====================

  drawSkeleton(landmarks, options = {}) {
    if (!this.ctx || !this.canvasEl) return;

    const w = this.canvasEl.width;
    const h = this.canvasEl.height;

    // 清除画布
    this.ctx.clearRect(0, 0, w, h);

    if (!landmarks) return;

    // 绘制目标骨架（半透明青色）
    if (options.targetLandmarks) {
      this._drawPose(options.targetLandmarks, w, h, '#40d8d8', 8, 0.3, true);
    }

    // 绘制实时骨架
    const color = options.color || (options.matched ? '#54e58a' : (options.deviation ? '#ffb547' : '#8da6ba'));
    this._drawPose(landmarks, w, h, color, 4, 1.0, false);
  },

  _drawPose(landmarks, w, h, color, lineWidth, alpha, dashed) {
    const ctx = this.ctx;
    // 按当前 canvas 实际像素/CSS 像素比缩放线宽（训练高清屏与建模画布通用）
    const rect = this.canvasEl.getBoundingClientRect();
    const dpr = rect.width ? this.canvasEl.width / rect.width : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (dashed) {
      ctx.setLineDash([8 * dpr, 6 * dpr]);
    } else {
      ctx.setLineDash([]);
    }

    // 绘制连接线
    for (const [start, end] of this.CONNECTIONS) {
      const s = landmarks[start];
      const e = landmarks[end];
      if (s && e) {
        const sp = this._mapPt(s);
        const ep = this._mapPt(e);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(ep.x, ep.y);
        ctx.stroke();
      }
    }

    // 绘制关键点
    ctx.setLineDash([]);
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      if (!lm) continue;
      // 只绘制主要关键点
      if (this.KEYPOINT_INDICES) {
        const isMain = Object.values(this.KEYPOINT_INDICES).includes(i) || i === 0;
        if (!isMain && i !== 11 && i !== 12 && i !== 13 && i !== 14 && i !== 15 && i !== 16
            && i !== 23 && i !== 24 && i !== 25 && i !== 26 && i !== 27 && i !== 28) continue;
      }
      const pt = this._mapPt(lm);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  },

  // ==================== 预置姿态模板 ====================

  PRESET_POSES: {
    quadSupport: {
      name: '四肢支撑',
      threshold: 85,
      angles: {
        leftElbow: 170, rightElbow: 170,
        leftShoulder: 90, rightShoulder: 90,
        leftHip: 90, rightHip: 90,
        leftKnee: 170, rightKnee: 170,
      },
      tolerance: { leftElbow: 15, rightElbow: 15, leftShoulder: 20, rightShoulder: 20, leftHip: 15, rightHip: 15, leftKnee: 15, rightKnee: 15 },
      voicePrompt: '请保持四肢支撑，背部平直',
    },
    kneeling: {
      name: '跪姿保持',
      threshold: 88,
      angles: {
        leftElbow: 160, rightElbow: 160,
        leftShoulder: 130, rightShoulder: 130,
        leftHip: 120, rightHip: 120,
        leftKnee: 90, rightKnee: 90,
      },
      tolerance: { leftElbow: 15, rightElbow: 15, leftShoulder: 15, rightShoulder: 15, leftHip: 15, rightHip: 15, leftKnee: 10, rightKnee: 10 },
      voicePrompt: '跪姿保持，双手前伸',
    },
    armsUp: {
      name: '双臂上举',
      threshold: 90,
      angles: {
        leftElbow: 170, rightElbow: 170,
        leftShoulder: 160, rightShoulder: 160,
        leftHip: 170, rightHip: 170,
        leftKnee: 170, rightKnee: 170,
      },
      tolerance: { leftElbow: 10, rightElbow: 10, leftShoulder: 15, rightShoulder: 15, leftHip: 15, rightHip: 15, leftKnee: 15, rightKnee: 15 },
      voicePrompt: '双臂向上伸展',
    },
  },

  getPresetPose(id) {
    const pose = this.PRESET_POSES[id];
    if (!pose) return null;
    return {
      ...pose,
      source: 'preset',
    };
  },

  // ==================== 取景检查 ====================

  checkFraming(landmarks) {
    if (!landmarks) return { pass: false, reason: '未检测到人体' };

    // 检查头部和脚踝是否都在画面内
    const head = landmarks[0];
    const leftAnkle = landmarks[27];
    const rightAnkle = landmarks[28];

    if (!head) return { pass: false, reason: '未检测到头部' };

    const hasAnkle = leftAnkle || rightAnkle;
    if (!hasAnkle) return { pass: false, reason: '未检测到脚踝，可能未全身入镜' };

    // 检查距离（根据关键点间距估算）
    const nose = landmarks[0];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    if (leftShoulder && rightShoulder) {
      const shoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
      // 肩膀宽度在画面中的比例，太小说明太远
      if (shoulderWidth < 0.15) return { pass: false, reason: '距离太远，请靠近' };
      if (shoulderWidth > 0.6) return { pass: false, reason: '距离太近，请后退' };
    }

    return { pass: true, reason: '' };
  },
};
