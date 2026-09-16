/**
 * 数据存储层
 * 使用 IndexedDB 存储姿态模板、训练计划、训练记录
 * 使用 localStorage 存储设置
 */
const Store = {
  db: null,
  DB_NAME: 'coyote3_pose_trainer',
  DB_VERSION: 1,

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // 姿态模板
        if (!db.objectStoreNames.contains('poseTemplates')) {
          db.createObjectStore('poseTemplates', { keyPath: 'id' });
        }
        // 训练计划
        if (!db.objectStoreNames.contains('trainingPlans')) {
          db.createObjectStore('trainingPlans', { keyPath: 'id' });
        }
        // 训练记录
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        // 波形模板
        if (!db.objectStoreNames.contains('waveformTemplates')) {
          db.createObjectStore('waveformTemplates', { keyPath: 'id' });
        }
        // 安全事件日志
        if (!db.objectStoreNames.contains('safetyEvents')) {
          db.createObjectStore('safetyEvents', { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => { this.db = e.target.result; resolve(true); };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ==================== 通用 CRUD ====================

  _tx(storeName, mode = 'readonly') {
    return this.db.transaction(storeName, mode).objectStore(storeName);
  },

  _put(storeName, item) {
    return new Promise((resolve, reject) => {
      const tx = this._tx(storeName, 'readwrite');
      const req = tx.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  },

  _get(storeName, id) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  _getAll(storeName) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  _delete(storeName, id) {
    return new Promise((resolve, reject) => {
      const req = this._tx(storeName, 'readwrite').delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  // ==================== 姿态模板 ====================

  async savePoseTemplate(template) {
    template.id = template.id || 'pose_' + Date.now();
    template.updatedAt = Date.now();
    return this._put('poseTemplates', template);
  },

  async getPoseTemplate(id) {
    return this._get('poseTemplates', id);
  },

  async getAllPoseTemplates() {
    return this._getAll('poseTemplates');
  },

  async deletePoseTemplate(id) {
    return this._delete('poseTemplates', id);
  },

  // ==================== 训练计划 ====================

  async savePlan(plan) {
    plan.id = plan.id || 'plan_' + Date.now();
    plan.updatedAt = Date.now();
    return this._put('trainingPlans', plan);
  },

  async getPlan(id) {
    return this._get('trainingPlans', id);
  },

  async getAllPlans() {
    return this._getAll('trainingPlans');
  },

  // ==================== 训练记录 ====================

  async saveSession(session) {
    session.id = session.id || 'session_' + Date.now();
    session.savedAt = Date.now();
    return this._put('sessions', session);
  },

  async getAllSessions() {
    const sessions = await this._getAll('sessions');
    return sessions.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  },

  // ==================== 波形模板 ====================

  async saveWaveformTemplate(template) {
    template.id = template.id || 'wf_' + Date.now();
    return this._put('waveformTemplates', template);
  },

  async getAllWaveformTemplates() {
    return this._getAll('waveformTemplates');
  },

  // ==================== 安全事件 ====================

  async saveSafetyEvent(event) {
    event.id = event.id || 'evt_' + Date.now();
    event.timestamp = event.timestamp || Date.now();
    return this._put('safetyEvents', event);
  },

  // ==================== 设置（localStorage） ====================

  getSettings() {
    const defaults = {
      threshold: 85,
      cooldown: 10,
      aLimit: 80,
      bLimit: 80,
      maxTime: 60,
      voiceStyle: 'coach',
      voiceVolume: 80,
      saveVideo: false,
      saveData: true,
      ackIntro: false,
    };
    try {
      const saved = JSON.parse(localStorage.getItem('coyote3_settings') || '{}');
      return { ...defaults, ...saved };
    } catch { return defaults; }
  },

  saveSettings(settings) {
    localStorage.setItem('coyote3_settings', JSON.stringify(settings));
  },

  // ==================== 记住设备 ====================

  getRememberedDevice() {
    return localStorage.getItem('coyote3_device');
  },

  rememberDevice(deviceId, deviceName) {
    localStorage.setItem('coyote3_device', JSON.stringify({ id: deviceId, name: deviceName }));
  },

  forgetDevice() {
    localStorage.removeItem('coyote3_device');
  },
};
