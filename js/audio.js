/**
 * 语音与音效模块
 * 使用 Web Speech API (TTS) 和 Web Audio API
 */
const AudioModule = {
  synth: null,
  audioCtx: null,
  voiceStyle: 'coach',
  volume: 0.8,
  enabled: true,

  // 纠偏文案模板
  CORRECTIONS: {
    coach: {
      leftElbow:   '左肘角度偏差，请调整左臂',
      rightElbow:  '右肘角度偏差，请调整右臂',
      leftShoulder:'左肩位置偏差，请调整左臂位置',
      rightShoulder:'右肩位置偏差，请调整右臂位置',
      leftHip:     '左髋角度偏差，请调整腰部',
      rightHip:    '右髋角度偏差，请调整腰部',
      leftKnee:    '左膝角度偏差，请调整左腿',
      rightKnee:   '右膝角度偏差，请调整右腿',
    },
    brief: {
      leftElbow:   '左臂',
      rightElbow:  '右臂',
      leftShoulder:'左肩',
      rightShoulder:'右肩',
      leftHip:     '腰部',
      rightHip:    '腰部',
      leftKnee:    '左腿',
      rightKnee:   '右腿',
    },
  },

  REMINDERS: {
    5: '请纠正姿态',
    10: '请立即调整，姿态仍未恢复',
    correct: '姿态正确，继续保持',
    trigger: '模拟触发，实际输出保持为零',
  },

  init() {
    if ('speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
    }
    if ('AudioContext' in window || 'webkitAudioContext' in window) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },

  setStyle(style) { this.voiceStyle = style; },
  setVolume(vol) { this.volume = vol / 100; },
  setEnabled(enabled) { this.enabled = enabled; },

  // ==================== TTS 语音 ====================

  speak(text, opts = {}) {
    if (!this.enabled || !this.synth) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'zh-CN';
    utter.rate = opts.rate || 1.0;
    utter.pitch = opts.pitch || 1.0;
    utter.volume = opts.volume || this.volume;

    // 尝试使用中文语音
    const voices = this.synth.getVoices();
    const zhVoice = voices.find(v => v.lang.startsWith('zh'));
    if (zhVoice) utter.voice = zhVoice;

    this.synth.cancel();
    this.synth.speak(utter);
  },

  // ==================== 纠偏语音 ====================

  speakCorrection(jointName) {
    const templates = this.CORRECTIONS[this.voiceStyle] || this.CORRECTIONS.coach;
    const text = templates[jointName] || `请调整 ${jointName}`;
    this.speak(text);
  },

  speakReminder(phase) {
    const text = this.REMINDERS[phase] || '';
    if (text) this.speak(text);
  },

  speakCorrect() {
    this.speak(this.REMINDERS.correct);
  },

  speakTrigger() {
    this.speak(this.REMINDERS.trigger);
  },

  // ==================== 声音效果 ====================

  playBeep(frequency = 880, duration = 200, type = 'sine') {
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();

    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(this.volume * 0.3, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration / 1000);

    osc.connect(gain);
    gain.connect(this.audioCtx.destination);

    osc.start();
    osc.stop(this.audioCtx.currentTime + duration / 1000);
  },

  playAlert() {
    // 连续三个短音
    this.playBeep(880, 100);
    setTimeout(() => this.playBeep(880, 100), 150);
    setTimeout(() => this.playBeep(1100, 200), 300);
  },

  playWarning() {
    // 两声低音
    this.playBeep(440, 200, 'square');
    setTimeout(() => this.playBeep(440, 200, 'square'), 300);
  },

  playTrigger() {
    // 长低音 + 振动
    this.playBeep(220, 600, 'sawtooth');
    this.vibrate([120, 80, 120, 80, 200]);
  },

  // ==================== 振动 ====================

  vibrate(pattern) {
    if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  },

  stopVibrate() {
    if ('vibrate' in navigator) {
      navigator.vibrate(0);
    }
  },
};
