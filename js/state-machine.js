/**
 * 训练状态机
 * 状态流转: 准备 → 正常 → 偏离0-5s → 提醒5-10s → 警告10-15s → 模拟触发 → 冷却
 * 计时重置: 匹配度恢复到阈值并满足防抖时长后清零
 * 安全锁定: STOP/异常时清空队列、零输出、显示原因
 */
const StateMachine = {
  // 状态枚举
  STATES: {
    IDLE: 'idle',
    PREPARE: 'prepare',
    NORMAL: 'normal',
    DEVIATION_0_5: 'deviation_0_5',      // 偏离 0~5 秒
    REMINDER_5_10: 'reminder_5_10',      // 提醒 5~10 秒
    WARNING_10_15: 'warning_10_15',      // 警告 10~15 秒
    SIMULATED: 'simulated',              // 模拟触发
    COOLDOWN: 'cooldown',               // 冷却
    SAFETY_LOCK: 'safety_lock',         // 安全锁定
  },

  currentState: 'idle',
  deviationSeconds: 0,
  cooldownSeconds: 0,
  correctDuration: 0,
  matchScore: 0,
  threshold: 85,
  isDeviating: false,

  // 防抖计时
  recoveryDebounce: 0,
  debounceTarget: 1, // 恢复后1秒内持续达标才清零

  // 冷却配置
  cooldownDuration: 10,
  cooldownTimer: null,
  tickTimer: null,

  // 事件统计
  deviationCount: 0,
  correctionCount: 0,
  simulatedEvents: [],
  matchSeries: [],

  // 回调
  onStateChange: null,
  onTick: null,
  onSimulatedEvent: null,
  onSafetyLock: null,

  // ==================== 状态控制 ====================

  reset() {
    this._clearTimers();
    this.currentState = this.STATES.IDLE;
    this.deviationSeconds = 0;
    this.cooldownSeconds = 0;
    this.correctDuration = 0;
    this.matchScore = 0;
    this.isDeviating = false;
    this.recoveryDebounce = 0;
    this.deviationCount = 0;
    this.correctionCount = 0;
    this.simulatedEvents = [];
    this.matchSeries = [];
    this._notifyStateChange();
  },

  startTraining(threshold = 85) {
    this.reset();
    this.threshold = threshold;
    this.currentState = this.STATES.PREPARE;
    this._notifyStateChange();
  },

  enterNormal() {
    this.currentState = this.STATES.NORMAL;
    this.deviationSeconds = 0;
    this.isDeviating = false;
    this.recoveryDebounce = 0;
    this._startTick();
    this._notifyStateChange();
  },

  // ==================== 主循环 ====================

  _startTick() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this._tick(), 1000);
  },

  _clearTimers() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.cooldownTimer) { clearInterval(this.cooldownTimer); this.cooldownTimer = null; }
  },

  _tick() {
    if (this.currentState === this.STATES.SAFETY_LOCK) return;

    // 记录匹配度序列
    this.matchSeries.push(this.matchScore);
    if (this.matchSeries.length > 3600) this.matchSeries.shift();

    if (this.isDeviating) {
      this.deviationSeconds++;

      // 状态流转 5/10/15
      if (this.deviationSeconds === 5) {
        this.currentState = this.STATES.REMINDER_5_10;
        this.correctionCount++;
        this._onCorrection('第一次语音纠偏');
      } else if (this.deviationSeconds === 10) {
        this.currentState = this.STATES.WARNING_10_15;
        this.correctionCount++;
        this._onCorrection('第二次语音警告');
      } else if (this.deviationSeconds >= 15) {
        this._triggerSimulated();
      }
    } else {
      this.correctDuration++;
    }

    this._notifyTick();
  },

  // ==================== 匹配度更新 ====================

  updateMatch(score, detected = true) {
    this.matchScore = score;

    // 安全状态机：未检测到人体不累计
    if (!detected) {
      if (this.currentState !== this.STATES.SAFETY_LOCK &&
          this.currentState !== this.STATES.IDLE &&
          this.currentState !== this.STATES.PREPARE) {
        // 不视为违规，暂停偏离计时
        this._notifyTick();
      }
      return;
    }

    if (this.currentState === this.STATES.PREPARE ||
        this.currentState === this.STATES.IDLE ||
        this.currentState === this.STATES.SAFETY_LOCK) return;

    // 判断是否偏离
    const wasDeviating = this.isDeviating;
    this.isDeviating = score < this.threshold;

    if (this.isDeviating) {
      this.recoveryDebounce = 0;

      // 从正常进入偏离
      if (!wasDeviating) {
        this.deviationSeconds = 0;
        this.currentState = this.STATES.DEVIATION_0_5;
        this.deviationCount++;
        this._notifyStateChange();
      }
    } else {
      // 恢复合格姿态
      this.recoveryDebounce++;

      if (this.recoveryDebounce >= this.debounceTarget) {
        // 防抖通过，清零偏离计时
        if (wasDeviating) {
          this.deviationSeconds = 0;
          this.isDeviating = false;
          this.currentState = this.STATES.NORMAL;

          // 如果是从模拟触发/冷却恢复，播报姿态正确
          if (wasDeviating) {
            this._onCorrection('姿态正确');
          }
          this._notifyStateChange();
        }
      }
    }
  },

  // ==================== 模拟触发 ====================

  _triggerSimulated() {
    this.currentState = this.STATES.SIMULATED;

    // 记录事件
    const event = {
      timestamp: Date.now(),
      type: 'simulated_trigger',
      score: this.matchScore,
      deviationDuration: this.deviationSeconds,
      action: 'vibration_sound_animation',
    };
    this.simulatedEvents.push(event);

    // 回调通知
    if (this.onSimulatedEvent) this.onSimulatedEvent(event);

    // 进入冷却
    this.currentState = this.STATES.COOLDOWN;
    this.cooldownSeconds = 0;
    this._startCooldown();
    this._notifyStateChange();
  },

  _startCooldown() {
    if (this.cooldownTimer) clearInterval(this.cooldownTimer);
    this.cooldownSeconds = 0;
    this.cooldownTimer = setInterval(() => {
      this.cooldownSeconds++;
      this._notifyTick();

      if (this.cooldownSeconds >= this.cooldownDuration) {
        clearInterval(this.cooldownTimer);
        this.cooldownTimer = null;

        if (this.isDeviating) {
          // 仍然偏离，再次触发
          this.deviationSeconds = 15;
          this._triggerSimulated();
        } else {
          // 恢复正常
          this.currentState = this.STATES.NORMAL;
          this.deviationSeconds = 0;
          this._notifyStateChange();
        }
      }
    }, 1000);
  },

  // ==================== 安全锁定 ====================

  lockSafety(reason) {
    this._clearTimers();
    this.currentState = this.STATES.SAFETY_LOCK;
    this.deviationSeconds = 0;
    this.isDeviating = false;

    if (this.onSafetyLock) this.onSafetyLock(reason);
    this._notifyStateChange();
  },

  // 手动恢复（需要用户确认）
  resumeFromLock() {
    this.currentState = this.STATES.IDLE;
    this._notifyStateChange();
  },

  // ==================== 偏离模拟（演示用） ====================

  simulateDeviation(enabled) {
    if (enabled) {
      this.isDeviating = true;
      this.deviationSeconds = 0;
      this.currentState = this.STATES.DEVIATION_0_5;
      if (!this.tickTimer) this._startTick();
    } else {
      this.isDeviating = false;
      this.deviationSeconds = 0;
      this.recoveryDebounce = this.debounceTarget;
      this.currentState = this.STATES.NORMAL;
    }
    this._notifyStateChange();
    this._notifyTick();
  },

  // ==================== 获取状态信息 ====================

  getStateInfo() {
    const stateLabels = {
      idle: '空闲',
      prepare: '准备中',
      normal: '正常',
      deviation_0_5: '偏离',
      reminder_5_10: '第一次提醒',
      warning_10_15: '第二次警告',
      simulated: '模拟触发',
      cooldown: '冷却',
      safety_lock: '安全锁定',
    };

    return {
      state: this.currentState,
      label: stateLabels[this.currentState] || this.currentState,
      deviationSeconds: this.deviationSeconds,
      cooldownSeconds: this.cooldownSeconds,
      correctDuration: this.correctDuration,
      matchScore: this.matchScore,
      threshold: this.threshold,
      isDeviating: this.isDeviating,
    };
  },

  // ==================== 训练报告 ====================

  getReport() {
    return {
      correctDuration: this.correctDuration,
      deviationCount: this.deviationCount,
      correctionCount: this.correctionCount,
      simulatedEvents: [...this.simulatedEvents],
      matchSeries: [...this.matchSeries],
      stopReason: this.currentState === this.STATES.SAFETY_LOCK ? '安全锁定' : '正常结束',
    };
  },

  // ==================== 回调 ====================

  _notifyStateChange() {
    if (this.onStateChange) this.onStateChange(this.getStateInfo());
  },

  _notifyTick() {
    if (this.onTick) this.onTick(this.getStateInfo());
  },

  _onCorrection(message) {
    // 纠偏事件回调通过 onStateChange 传递
    this._notifyStateChange();
    if (this.onSimulatedEvent) {
      this.onSimulatedEvent({
        timestamp: Date.now(),
        type: 'correction',
        message: message,
        score: this.matchScore,
        deviationDuration: this.deviationSeconds,
      });
    }
  },
};
