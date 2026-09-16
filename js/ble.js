/**
 * 郊狼3.0 BLE 适配器
 * 基于 DG-LAB-OPENSOURCE V3 协议
 * 服务UUID: 0x180C  写特性: 0x150A  通知特性: 0x150B
 * 指令: B0(强度+波形,20字节/100ms) BF(软上限+平衡,7字节)
 * 回应: B1(当前强度,4字节) BE(软上限+平衡,7字节)
 */
const CoyoteBLE = {
  // UUID 常量
  SERVICE_UUID:        '0000180c-0000-1000-8000-00805f9b34fb',
  WRITE_CHAR_UUID:     '0000150a-0000-1000-8000-00805f9b34fb',
  NOTIFY_CHAR_UUID:    '0000150b-0000-1000-8000-00805f9b34fb',
  DEVICE_NAME_PREFIX:  '47L1210',

  // 连接状态
  device: null,
  server: null,
  writeChar: null,
  notifyChar: null,
  connected: false,

  // 通道状态
  channelA: { strength: 0, ceiling: 200, freqBalance: 100, intensityBalance: 100 },
  channelB: { strength: 0, ceiling: 200, freqBalance: 100, intensityBalance: 100 },

  // B0 指令相关
  seqNo: 0,
  inputOrderNo: 0,
  isInputAllowed: true,
  accumulatedA: 0,
  accumulatedB: 0,

  // 100ms 定时器
  b0Timer: null,
  // 波形数据（每100ms发送4组）
  waveformA: { freq: [10,10,10,10], intensity: [0,0,0,0] },
  waveformB: { freq: [10,10,10,10], intensity: [0,0,0,0] },

  // 回调
  onStatusChange: null,
  onStrengthUpdate: null,
  onError: null,

  // ==================== 连接管理 ====================

  async scan() {
    if (!navigator.bluetooth) {
      throw new Error('当前浏览器不支持 Web Bluetooth API，请使用 Chrome 56+ 或 Edge。');
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: this.DEVICE_NAME_PREFIX },
        { services: [this.SERVICE_UUID] }
      ],
      optionalServices: [this.SERVICE_UUID]
    });
    return device;
  },

  async connect(device) {
    this.device = device;
    this.server = await device.gatt.connect();

    const service = await this.server.getPrimaryService(this.SERVICE_UUID);
    this.writeChar = await service.getCharacteristic(this.WRITE_CHAR_UUID);
    this.notifyChar = await service.getCharacteristic(this.NOTIFY_CHAR_UUID);

    // 绑定通知
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e));

    // 监听断连
    device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    this.connected = true;
    this._notifyStatus();

    // 请求 BE 消息获取当前软上限
    await this._requestBE();

    // 启动100ms B0循环
    this._startB0Cycle();

    return true;
  },

  disconnect() {
    this._stopB0Cycle();
    // 发送零输出
    this._setStrengthZero();
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.connected = false;
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._notifyStatus();
  },

  _onDisconnect() {
    this._stopB0Cycle();
    this.connected = false;
    this.channelA.strength = 0;
    this.channelB.strength = 0;
    this._notifyStatus();
    if (this.onError) this.onError('BLE 连接已断开');
  },

  // ==================== B0 指令构造与发送 ====================

  /**
   * 构造 B0 指令 (20字节)
   * byte0: 0xB0
   * byte1: (seqNo << 4) | method  [method: A高2位 B低2位, 00不变 01增 10减 11绝对]
   * byte2: A通道强度设定值
   * byte3: B通道强度设定值
   * byte4-7: A波形频率4条
   * byte8-11: A波形强度4条
   * byte12-15: B波形频率4条
   * byte16-19: B波形强度4条
   */
  _buildB0(seqNo, method, strengthA, strengthB, wfAFreq, wfAInt, wfBFreq, wfBInt) {
    const buf = new ArrayBuffer(20);
    const view = new DataView(buf);
    view.setUint8(0, 0xB0);
    view.setUint8(1, ((seqNo & 0x0F) << 4) | (method & 0x0F));
    view.setUint8(2, strengthA & 0xFF);
    view.setUint8(3, strengthB & 0xFF);
    for (let i = 0; i < 4; i++) {
      view.setUint8(4 + i, wfAFreq[i] & 0xFF);
      view.setUint8(8 + i, wfAInt[i] & 0xFF);
      view.setUint8(12 + i, wfBFreq[i] & 0xFF);
      view.setUint8(16 + i, wfBInt[i] & 0xFF);
    }
    return buf;
  },

  /**
   * 强度数据处理
   * 处理累积强度变化值，构造指令
   */
  _processStrength() {
    let method = 0; // 0b0000 = 都不变
    let setA = 0, setB = 0;
    let seq = 0;

    if (this.isInputAllowed) {
      // A通道
      let aMethod = 0, bMethod = 0;
      if (this.accumulatedA > 0) {
        aMethod = 0b01; // 增加
        setA = Math.min(this.accumulatedA, 200);
      } else if (this.accumulatedA < 0) {
        aMethod = 0b10; // 减少
        setA = Math.min(Math.abs(this.accumulatedA), 200);
      }
      if (this.accumulatedB > 0) {
        bMethod = 0b01;
        setB = Math.min(this.accumulatedB, 200);
      } else if (this.accumulatedB < 0) {
        bMethod = 0b10;
        setB = Math.min(Math.abs(this.accumulatedB), 200);
      }
      method = (aMethod << 2) | bMethod;

      if (method !== 0) {
        this.seqNo = (this.seqNo % 15) + 1;
        seq = this.seqNo;
        this.inputOrderNo = seq;
        this.isInputAllowed = false;
      }
      this.accumulatedA = 0;
      this.accumulatedB = 0;
    }

    return { seq, method, setA, setB };
  },

  /**
   * 100ms B0 循环
   */
  _startB0Cycle() {
    if (this.b0Timer) clearInterval(this.b0Timer);
    this.b0Timer = setInterval(() => this._sendB0(), 100);
  },

  _stopB0Cycle() {
    if (this.b0Timer) {
      clearInterval(this.b0Timer);
      this.b0Timer = null;
    }
  },

  async _sendB0() {
    if (!this.connected || !this.writeChar) return;

    const { seq, method, setA, setB } = this._processStrength();

    const buf = this._buildB0(
      seq, method, setA, setB,
      this.waveformA.freq, this.waveformA.intensity,
      this.waveformB.freq, this.waveformB.intensity
    );

    try {
      await this.writeChar.writeValue(buf);
    } catch (e) {
      // 写入失败，可能是连接断开
      console.warn('B0 write failed:', e);
    }
  },

  /**
   * 强度归零（安全用）
   */
  _setStrengthZero() {
    // 使用绝对设置，强度=0
    const buf = this._buildB0(
      1, 0b1100, 0, 0,  // seq=1, method: A=11(abs) B=00(no change), A strength=0
      [10,10,10,10], [0,0,0,0],
      [10,10,10,10], [0,0,0,0]
    );
    if (this.writeChar) {
      this.writeChar.writeValue(buf).catch(() => {});
    }
  },

  // ==================== BF 指令 ====================

  /**
   * 构造 BF 指令 (7字节)
   * 设置通道强度软上限 + 频率平衡 + 强度平衡
   */
  async sendBF(ceilingA, ceilingB, freqBalanceA, freqBalanceB, intBalanceA, intBalanceB) {
    if (!this.connected || !this.writeChar) return;

    const buf = new ArrayBuffer(7);
    const view = new DataView(buf);
    view.setUint8(0, 0xBF);
    view.setUint8(1, Math.min(ceilingA, 200));
    view.setUint8(2, Math.min(ceilingB, 200));
    view.setUint8(3, Math.min(freqBalanceA, 255));
    view.setUint8(4, Math.min(freqBalanceB, 255));
    view.setUint8(5, Math.min(intBalanceA, 255));
    view.setUint8(6, Math.min(intBalanceB, 255));

    try {
      await this.writeChar.writeValue(buf);
    } catch (e) {
      console.warn('BF write failed:', e);
    }
  },

  /**
   * 请求 BE 消息（读取当前设置）
   */
  async _requestBE() {
    // 读取 notify 特性的当前值
    if (this.notifyChar) {
      try {
        const value = await this.notifyChar.readValue();
        this._parseNotify(value);
      } catch (e) {
        // 某些设备需要等待通知
      }
    }
  },

  // ==================== 通知处理 ====================

  _onNotify(event) {
    const data = event.target.value;
    this._parseNotify(data);
  },

  _parseNotify(data) {
    if (data.byteLength < 1) return;
    const cmd = data.getUint8(0);

    if (cmd === 0xB1 && data.byteLength >= 4) {
      // B1: 当前强度
      const returnSeq = data.getUint8(1);
      const strengthA = data.getUint8(2);
      const strengthB = data.getUint8(3);

      this.channelA.strength = strengthA;
      this.channelB.strength = strengthB;

      // 处理序列号匹配
      if (returnSeq === this.inputOrderNo && returnSeq !== 0) {
        this.isInputAllowed = true;
        this.inputOrderNo = 0;
      }

      this._notifyStrength();
    } else if (cmd === 0xBE && data.byteLength >= 7) {
      // BE: 软上限 + 平衡参数
      this.channelA.ceiling = data.getUint8(1);
      this.channelB.ceiling = data.getUint8(2);
      this.channelA.freqBalance = data.getUint8(3);
      this.channelB.freqBalance = data.getUint8(4);
      this.channelA.intensityBalance = data.getUint8(5);
      this.channelB.intensityBalance = data.getUint8(6);

      this._notifyStrength();
    }
  },

  // ==================== 公开 API ====================

  /**
   * 设置 A 通道强度（绝对值）
   */
  setStrengthA(value) {
    value = Math.max(0, Math.min(value, this.channelA.ceiling));
    const diff = value - this.channelA.strength;
    if (diff !== 0) this.accumulatedA += diff;
  },

  /**
   * 设置 B 通道强度（绝对值）
   */
  setStrengthB(value) {
    value = Math.max(0, Math.min(value, this.channelB.ceiling));
    const diff = value - this.channelB.strength;
    if (diff !== 0) this.accumulatedB += diff;
  },

  /**
   * 增减 A 通道强度
   */
  adjustA(delta) {
    const target = this.channelA.strength + delta;
    if (target < 0 || target > this.channelA.ceiling) return;
    this.accumulatedA += delta;
  },

  /**
   * 增减 B 通道强度
   */
  adjustB(delta) {
    const target = this.channelB.strength + delta;
    if (target < 0 || target > this.channelB.ceiling) return;
    this.accumulatedB += delta;
  },

  /**
   * 设置波形数据
   * freqArray: 4个频率值 (10~240)
   * intArray: 4个强度值 (0~100)
   */
  setWaveformA(freqArray, intArray) {
    this.waveformA.freq = freqArray.slice(0, 4);
    this.waveformA.intensity = intArray.slice(0, 4);
  },

  setWaveformB(freqArray, intArray) {
    this.waveformB.freq = freqArray.slice(0, 4);
    this.waveformB.intensity = intArray.slice(0, 4);
  },

  /**
   * 紧急停止：立即归零
   */
  emergencyStop() {
    this.accumulatedA = 0;
    this.accumulatedB = 0;
    this._stopB0Cycle();
    // 发送绝对归零
    const buf = this._buildB0(
      1, 0b1111, 0, 0,  // A=abs(0), B=abs(0)
      [10,10,10,10], [0,0,0,0],
      [10,10,10,10], [0,0,0,0]
    );
    if (this.writeChar) {
      this.writeChar.writeValue(buf).catch(() => {});
    }
    this.channelA.strength = 0;
    this.channelB.strength = 0;
    this._notifyStrength();

    // 重启循环（只发波形，强度为0）
    setTimeout(() => this._startB0Cycle(), 200);
  },

  // ==================== 回调通知 ====================

  _notifyStatus() {
    if (this.onStatusChange) {
      this.onStatusChange({
        connected: this.connected,
        deviceName: this.device ? this.device.name : null,
        deviceId: this.device ? this.device.id : null,
      });
    }
  },

  _notifyStrength() {
    if (this.onStrengthUpdate) {
      this.onStrengthUpdate({
        a: { ...this.channelA },
        b: { ...this.channelB },
      });
    }
  },

  // ==================== 波形频率换算 ====================

  /**
   * 将10~1000的输入值换算为10~240的波形频率
   */
  convertFrequency(input) {
    if (input >= 10 && input <= 100) return input;
    if (input >= 101 && input <= 600) return Math.round((input - 100) / 5 + 100);
    if (input >= 601 && input <= 1000) return Math.round((input - 600) / 10 + 200);
    return 10;
  },

  /**
   * 生成预设波形
   */
  generateWaveform(type) {
    const presets = {
      pulse:   { freq: [10,10,10,10], int: [0,25,50,25] },
      breath:  { freq: [80,80,80,80], int: [10,40,60,40] },
      wave:    { freq: [60,80,100,80], int: [30,60,80,60] },
      tease:   { freq: [10,150,10,150], int: [0,50,20,70] },
      idle:    { freq: [10,10,10,10], int: [0,0,0,0] },
    };
    return presets[type] || presets.idle;
  },
};
