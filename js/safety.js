/**
 * 安全层
 * 统一判断是否允许事件继续，拥有最终否决权
 * 处理: STOP、后台/锁屏、BLE断连、人体丢失/多人/遮挡、超时
 */
const SafetyLayer = {
  locked: false,
  lockReason: '',

  // 回调
  onLock: null,
  onUnlock: null,

  // ==================== 安全检查 ====================

  checkPoseResult(result) {
    if (!result) return { allow: false, reason: '无数据' };

    // 人体丢失
    if (!result.detected) {
      return { allow: false, reason: '未检测到人体', safe: true };
    }

    // 多人
    if (result.personCount > 1) {
      return { allow: false, reason: '检测到多人', safe: true };
    }

    // 置信度不足（MediaPipe 无直接置信度，用关键点完整性近似）
    const lm = result.landmarks;
    if (!lm) return { allow: false, reason: '关键点不完整', safe: true };

    return { allow: true };
  },

  // ==================== 锁定/解锁 ====================

  lock(reason, description) {
    if (this.locked) return;
    this.locked = true;
    this.lockReason = reason;

    // 清空训练状态
    StateMachine.lockSafety(reason);

    // BLE 零输出
    if (CoyoteBLE.connected) {
      CoyoteBLE.emergencyStop();
    }

    if (this.onLock) this.onLock(reason, description || reason);
  },

  unlock() {
    this.locked = false;
    this.lockReason = '';
    if (this.onUnlock) this.onUnlock();
  },

  // ==================== 事件监听 ====================

  setupEventListeners() {
    // 应用进入后台或锁屏
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.lock('应用后台', '应用进入后台，训练已自动停止');
      }
    });

    // 页面失焦
    window.addEventListener('blur', () => {
      // 只在训练中触发
      if (StateMachine.currentState !== StateMachine.STATES.IDLE &&
          StateMachine.currentState !== StateMachine.STATES.PREPARE) {
        // 短暂失焦可能只是切换标签，延迟检查
        setTimeout(() => {
          if (!document.hasFocus()) {
            this.lock('页面失焦', '应用失去焦点');
          }
        }, 500);
      }
    });

    // BLE 断连
    CoyoteBLE.onError = (msg) => {
      if (msg.includes('断开') || msg.includes('disconnect')) {
        this.lock('BLE 断连', '蓝牙连接已断开');
      }
    };

    // 超时检查
    this._setupTimeoutCheck();
  },

  _maxTrainingTime: 60 * 60, // 60分钟（秒）
  _trainingStartTime: null,
  _timeoutTimer: null,

  startTrainingTimer(maxMinutes) {
    this._maxTrainingTime = (maxMinutes || 60) * 60;
    this._trainingStartTime = Date.now();

    if (this._timeoutTimer) clearInterval(this._timeoutTimer);
    this._timeoutTimer = setInterval(() => {
      if (this.locked) {
        clearInterval(this._timeoutTimer);
        return;
      }
      const elapsed = (Date.now() - this._trainingStartTime) / 1000;
      if (elapsed >= this._maxTrainingTime) {
        this.lock('训练超时', `训练已达${maxMinutes}分钟上限`);
      }
    }, 10000); // 每10秒检查一次
  },

  stopTrainingTimer() {
    if (this._timeoutTimer) {
      clearInterval(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  },

  _setupTimeoutCheck() {
    // 已在上方实现
  },
};
