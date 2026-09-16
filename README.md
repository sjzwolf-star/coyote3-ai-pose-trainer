# 郊狼3.0 AI视觉姿态训练 APP V1.0

基于 Web 技术的 AI 姿态训练应用，通过手机摄像头在本地识别人体关键点，与目标姿态骨架实时比较，按 5/10/15 秒状态机进行语音纠偏和模拟触发。支持郊狼3.0 BLE 连接，首阶段所有触发均为模拟事件（手机震动、声音、动画），不向人体输出电刺激。

## 功能特性

### 姿态识别与骨架对比
- 使用 MediaPipe Pose Landmarker 在本地检测 33 个人体关键点
- 实时骨架与半透明目标骨架叠加显示
- 基于关节角度和权重计算匹配度 (0-100分)
- 自动处理镜像姿态
- 一次只提示最大加权偏差的肢体动作

### 训练状态机
- 准备 → 正常 → 偏离0-5s → 提醒5-10s → 警告10-15s → 模拟触发 → 冷却
- 匹配度恢复后立即清零偏离计时（含防抖）
- 可配置模拟触发冷却间隔

### 安全层
- 全局 STOP 按钮永远可见且优先级最高
- APP 后台/锁屏自动进入安全锁定
- BLE 断连/协议异常时零输出并锁定
- 人体丢失/多人/遮挡时不视为违规
- 修改通道上限需退出训练
- 单次训练超时自动结束

### BLE 连接 (郊狼3.0)
- 基于 DG-LAB-OPENSOURCE V3 协议
- B0 指令：强度+波形数据 (20字节/100ms)
- BF 指令：软上限+平衡参数 (7字节)
- B1/BE 通知解析
- 设备发现、连接、自动重连、状态显示
- 手动控制面板（测试用）
- 首阶段实际输出始终为 0

### 姿态模板与图片建模
- 预置动作模板（四肢支撑、跪姿、双臂上举）
- 图片导入自动识别骨架和角度
- 拖动修正关键点
- 摄像头录制标准姿态

### 训练计划
- 时间轴编排（准备/动作/休息/完成）
- 每个动作单独配置阈值、语音和模拟方案

### 波形模板
- 预设波形（脉冲/呼吸/波浪/tease）
- 参数生成预览

### 数据存储
- IndexedDB 存储姿态模板、训练计划、训练记录
- localStorage 存储设置和设备记忆

## 技术栈

- **前端**: HTML5 + CSS3 + JavaScript (ES6+)
- **姿态检测**: Google MediaPipe Tasks Vision (PoseLandmarker)
- **BLE**: Web Bluetooth API
- **语音**: Web Speech API (TTS) + Web Audio API
- **存储**: IndexedDB + localStorage
- **PWA**: Service Worker + Web App Manifest

## 使用要求

- Android 手机，Chrome 56+ 或 Edge
- 需要蓝牙和摄像头权限
- 建议在 HTTPS 环境下使用（Web Bluetooth 要求）
- 郊狼3.0 脉冲主机（设备名: 47L121000）

## 部署到 GitHub Pages

1. 将本仓库推送到 GitHub
2. 在仓库 Settings → Pages 中启用 GitHub Pages
3. 选择 main 分支根目录
4. 访问 `https://<username>.github.io/<repo-name>/`

## 安全说明

- 首阶段所有触发均为模拟事件（震动、声音、动画）
- 不向人体输出电刺激
- 摄像头画面默认仅本地处理
- 原始视频不落盘
- 真实输出能力需独立安全评审后决定，不属于 V1.0

## BLE 协议参考

- [DG-LAB-OPENSOURCE](https://github.com/Vpn33/DG-LAB-OPENSOURCE)
- Service UUID: 0x180C
- Write: 0x150A, Notify: 0x150B
- B0: 强度+波形, BF: 软上限, B1: 强度回应, BE: 设置回应

## 许可证

本项目为安全模拟原型，供研究和验证使用。
