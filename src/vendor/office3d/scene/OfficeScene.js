import * as THREE from 'three';
import gsap from 'gsap';
import { agentsData } from '../data/agentsData.js';
import { OfficeEnvironment } from './Environment.js';
import { Workstation } from './Workstation.js';
import { WorkstationKit } from './WorkstationKit.js';
import { AgentAvatar } from './AgentAvatar.js';
import { TaskTransferManager } from './TaskTransfer.js';
import { SelectionRing } from './SelectionRing.js';

export class OfficeScene {
  constructor(container, onSelectAgent, options = {}) {
    this.container = container;
    this.onSelectAgent = onSelectAgent;
    // 兼容模式（无显卡/软件渲染）：关闭抗锯齿与阴影、像素比强制 1
    this.compatMode = options.compatMode === true;
    // 内部渲染倍率（内存核心杠杆）：帧缓冲 = 容器尺寸 × 像素比 × 倍率
    // 0.75 → 缓冲像素 56%，0.5 → 25%，0.25 → 6%，画面由 CSS 拉伸
    this.renderScale = Math.min(1, Math.max(0.25, options.renderScale || 1));
    // 帧缓冲硬性上限（配合「禁止缩放 + 固定正视视角」）：
    // 任意屏幕/像素比下缓冲都不超过 1280×720，显存被永久封顶。
    // 抗锯齿开 ≈ 18MB、关 ≈ 7MB；4K 高分屏原本可达数百 MB。
    this.maxBufferW = options.maxBufferW || 1280;
    this.maxBufferH = options.maxBufferH || 720;
    // 阴影独立开关（默认开；兼容模式会强制叠加关闭）
    this.shadowsOn = true;

    this.selectedAgentId = 5; // Default select Dev-05
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // 渲染运行开关（暂停时停止更新与渲染，仅保留 rAF 空转）
    this.running = true;

    // FPS 档位控制（60/45/30/15）与实测帧率统计
    this.targetFps = 60;
    this.measuredFps = 60;
    this.frameCount = 0;
    this.fpsAccum = 0;
    this.lastRenderTime = 0;

    this.workstations = new Map();
    this.avatars = new Map();
    this.kit = null;

    // 投影复用缓冲（避免每帧分配对象造成的 GC 抖动）
    this._projScratch = new THREE.Vector3();
    this._projPositions = [];
    this._lastHoverTime = 0;

    // 固定取景状态：投影宽高比冻结 + letterbox 画布偏移。取景在首次获得真实
    // 尺寸时确定一次，之后宽高比漂移超阈值时防抖重取景（handleResize），
    // 阈值内的拖动只整体缩放（相机不动）。
    this._framingApplied = false;
    this.fixedAspect = null;
    this._letterbox = { x: 0, y: 0, w: 0, h: 0 };
    this._reframeTimer = null;

    this.initThree();
    this.initSubsystems();
    this.initInteraction();
    this.animate();
  }

  initThree() {
    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0d14);

    // 2. Camera (Low FOV Perspective Camera for authentic Isometric aesthetic)
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 150);
    // 仅保留正视角度：初始即正视视角（相机 (0,5.5,14) → 目标 (0,1,0)）。
    // baseCameraPos 是取景基准（不随 setCameraFraming 修改），defaultCameraPos 随
    // 取景调整、供 gsap 复位（setCameraView）使用。
    this.baseCameraPos = new THREE.Vector3(0, 5.5, 14);
    this.defaultCameraPos = this.baseCameraPos.clone();
    this.defaultCameraTarget = new THREE.Vector3(0, 1.0, 0);
    this.camera.position.copy(this.defaultCameraPos);

    // 3. Renderer
    this._antialias = !this.compatMode; // 记录抗锯齿开关（创建时决定，供内存估算）
    this.renderer = new THREE.WebGLRenderer({
      antialias: this._antialias,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.shadowMap.enabled = this.shadowsOn && !this.compatMode; // 阴影（兼容模式强制关）
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.applyRenderSize();

    this.container.appendChild(this.renderer.domElement);

    // 4. 固定正视视角（无控制器）：旋转/平移/缩放原本全部禁用，OrbitControls 是纯死重，
    //    已移除。改为每帧 camera.lookAt(cameraTarget)，gsap 移动相机/目标时视角自动跟随。
    this.cameraTarget = this.defaultCameraTarget.clone();
    this.camera.lookAt(this.cameraTarget);

    // Resize listener
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
  }

  initSubsystems() {
    // 1. Environment & Lighting
    this.environment = new OfficeEnvironment(this.scene);

    // 2. 全局工位静态家具（8 个工位外观一致，按零件跨工位 InstancedMesh 合并，
    //    静态家具的绘制调用从 ~38×8 降到 ~30 次）
    this.kit = new WorkstationKit(
      this.scene,
      agentsData.map((a) => ({ id: a.id, x: a.deskPos.x, z: a.deskPos.z }))
    );

    // 3. 8 Workstations & 8 Agent Avatars
    agentsData.forEach((agentConfig) => {
      const ws = new Workstation(agentConfig, this.scene);
      const avatar = new AgentAvatar(agentConfig, ws);
      this.workstations.set(agentConfig.id, ws);
      this.avatars.set(agentConfig.id, avatar);
    });

    // 4. 3D Task Transfer Manager
    this.taskTransfer = new TaskTransferManager(this.scene);

    // 5. 3D Holographic Ground Selection Ring
    this.selectionRing = new SelectionRing(this.scene);
    const initialAgent = agentsData.find((a) => a.id === this.selectedAgentId);
    if (initialAgent) {
      this.selectionRing.moveTo(initialAgent.deskPos.x, initialAgent.deskPos.z, true);
    }
  }

  initInteraction() {
    let pointerDownPos = { x: 0, y: 0 };

    // 射线检测目标：工位组（屏幕/椅子/角色）+ 全局实例化家具（通过 instanceId 反查工位）。
    // 只构建一次，避免每次事件重建数组。
    this.interactables = [];
    this.workstations.forEach((ws) => this.interactables.push(ws.group));
    if (this.kit) this.interactables.push(...this.kit.colliders);

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    });

    this.renderer.domElement.addEventListener('pointerup', (e) => {
      // Check if it was a click (not a camera drag)
      const dx = Math.abs(e.clientX - pointerDownPos.x);
      const dy = Math.abs(e.clientY - pointerDownPos.y);
      if (dx < 6 && dy < 6) {
        this.onClick(e);
      }
    });

    // Pointer move for hover feedback（节流：光标反馈无需每帧精确）
    this.renderer.domElement.addEventListener('pointermove', (e) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      const now = performance.now();
      if (now - this._lastHoverTime < 40) return; // ~25Hz 节流
      this._lastHoverTime = now;

      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersects = this.raycaster.intersectObjects(this.interactables, true);
      this.renderer.domElement.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
    });
  }

  onClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactables, true);
    if (intersects.length > 0) {
      const hit = intersects[0];
      let matchedId = null;

      if (hit.object.isInstancedMesh) {
        // 点击全局实例化家具：instanceId -> 工位索引
        const perDesk = hit.object.userData.perDesk || 1;
        const deskIdx = Math.floor(hit.instanceId / perDesk);
        const desk = this.kit ? this.kit.desks[deskIdx] : null;
        if (desk) matchedId = desk.id;
      } else {
        // 点击工位组内成员（屏幕/椅子/角色）：向上查找所属 ws.group
        let hitMesh = hit.object;
        while (hitMesh && hitMesh !== this.scene) {
          for (const [id, ws] of this.workstations.entries()) {
            if (ws.group === hitMesh) {
              matchedId = id;
              break;
            }
          }
          if (matchedId) break;
          hitMesh = hitMesh.parent;
        }
      }

      if (matchedId) {
        this.selectAgent(matchedId);
      }
    }
  }

  selectAgent(id) {
    this.selectedAgentId = id;
    const agent = agentsData.find((a) => a.id === id);
    if (!agent) return;

    // Glide selection ring to this workstation
    this.selectionRing.moveTo(agent.deskPos.x, agent.deskPos.z);

    if (this.onSelectAgent) {
      this.onSelectAgent(agent);
    }
  }

  setAgentStatus(id, status) {
    const avatar = this.avatars.get(id);
    const ws = this.workstations.get(id);
    if (avatar) avatar.setStatus(status);
    if (ws) ws.setStatus(status);
  }

  launchTaskTransfer(fromId, toId, onComplete) {
    const fromAgent = agentsData.find((a) => a.id === fromId);
    const toAgent = agentsData.find((a) => a.id === toId);
    if (!fromAgent || !toAgent) return;

    // Trigger receiving pose on recipient
    this.setAgentStatus(toId, 'receiving');

    this.taskTransfer.launchTransfer(fromAgent, toAgent, () => {
      this.setAgentStatus(toId, 'working');
      if (onComplete) onComplete();
    });
  }

  setCameraView() {
    // 仅保留正视角度：平滑复位到正视预设（初始视角即正视，此处作为复位用）
    const duration = 1.0;
    const ease = 'power2.inOut';

    gsap.to(this.camera.position, {
      x: this.defaultCameraPos.x,
      y: this.defaultCameraPos.y,
      z: this.defaultCameraPos.z,
      duration,
      ease,
    });
    gsap.to(this.cameraTarget, {
      x: this.defaultCameraTarget.x,
      y: this.defaultCameraTarget.y,
      z: this.defaultCameraTarget.z,
      duration,
      ease,
    });
  }

  /**
   * 固定取景：让人物变大、裁掉两侧空旷黑墙，但**保证 8 个工位全部入镜**。
   * 保持正视视角方向与瞄准点（defaultCameraTarget）不变，仅沿视线调整相机距离：
   * - 纵向约束（主）：后排脚部→前排头部 屏幕纵向跨度约 3.75 世界单位，
   *   按留边系数放大后装下（余量同时覆盖悬浮在头顶上方的标签）；
   * - 横向约束：按「工位中心跨度 11.4 + 桌体半宽余量」的全跨度计算，
   *   窄画布下允许相机退到比基准更远（不再被 base 距离截断）——
   *   截断曾导致窄面板下两侧工位被裁掉；
   * - MIN_DIST / MAX_DIST 兜底：避免过近的透视变形与过远的无限缩小。
   * 取景在首次获得真实尺寸时确定一次；之后容器**宽高比漂移超过阈值**时
   * （handleResize 内防抖触发）会重新取景，保证任何窗口/分割形状下 8 工位
   * 都完整入镜；漂移阈值内的拖动只做 letterbox 整体缩放，构图不跳变。
   */
  setCameraFraming() {
    if (!this.camera || !this.container) return;
    // 杀掉进行中的相机复位补丁动画（setCameraView），避免旧目标点把刚重取景的
    // 相机又拽回去。
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.cameraTarget);
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const halfTan = Math.tan((this.camera.fov / 2) * (Math.PI / 180)); // tan(17°)
    const baseDist = this.baseCameraPos.distanceTo(this.defaultCameraTarget);
    const V_SPAN = 3.75; // 8 人纵向屏幕跨度（世界单位）
    const V_MARGIN = 1.6; // 纵向留边 ~60%：8 人 + 头顶悬浮标签从容入镜
    const H_HALF = 7.0; // 横向半跨度：工位中心 ±5.7 再加桌体半宽余量
    const MIN_DIST = 9.5; // 取景下限：离场景稍远，避免近大远小透视过强、裁人
    const MAX_DIST = baseDist * 2.5; // 上限兜底：极端窄画布下不至于无限拉远
    let dist = (V_SPAN * V_MARGIN) / (2 * halfTan);
    dist = Math.max(dist, MIN_DIST);
    dist = Math.max(dist, H_HALF / (halfTan * aspect)); // 横向装下全部工位（含桌体）
    dist = Math.min(dist, MAX_DIST);
    const dir = this.baseCameraPos.clone().sub(this.defaultCameraTarget).normalize();
    const framed = this.defaultCameraTarget.clone().add(dir.multiplyScalar(dist));
    this.defaultCameraPos.copy(framed);
    this.camera.position.copy(framed);
    // 冻结投影宽高比：之后容器尺寸变化先做 letterbox 缩放，比例漂移过大再重构图。
    this.fixedAspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  handleResize() {
    // 防抖重取景：拖动分割条/窗口过程中只做 letterbox 缩放（不跳变）；
    // 停止 220ms 后若宽高比相对冻结值漂移超过 20%，重新取景一次——
    // 保证任何窗口形状下场景都完整、且尽量充满可视区。
    if (this._reframeTimer != null) clearTimeout(this._reframeTimer);
    this._reframeTimer = setTimeout(() => {
      this._reframeTimer = null;
      if (this.disposed || !this.camera || !this.container) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (!w || !h) return;
      const aspect = w / h;
      const frozen = this.fixedAspect || aspect;
      if (this._framingApplied && Math.abs(aspect / frozen - 1) > 0.2) {
        this.setCameraFraming();
        this._framingApplied = true;
      }
      this.applyRenderSize();
    }, 220);
    this.applyRenderSize();
  }

  /**
   * 统一计算渲染缓冲尺寸：缓冲像素 = 容器 × 像素比 × 渲染倍率，再封顶在 maxBufferW/H。
   * 像素比：兼容模式 1，否则 min(dpr, 2)。CSS 里 canvas 已 100% 拉伸，缓冲由浏览器放大显示。
   * 配合「禁止缩放 + 固定正视视角」，封顶后显存在任何机器上都被硬性限制。
   */
  applyRenderSize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    // 取景（相机位置 + 投影宽高比）在首次获得真实尺寸时确定；之后容器宽高比
    // 漂移超过阈值时由 handleResize 防抖重取景，阈值内的变化只做 letterbox
    // 整体缩放（构图不变）。
    if (!this._framingApplied) {
      this.setCameraFraming();
      this._framingApplied = true;
    }

    // 按固定投影宽高比 letterbox 适配容器：画布保持 fixedAspect，居中放置。
    const fixedAspect = this.fixedAspect || (width / height);
    let bufW = width;
    let bufH = height;
    if (width / height > fixedAspect) {
      bufH = height;
      bufW = Math.round(height * fixedAspect);
    } else {
      bufW = width;
      bufH = Math.round(width / fixedAspect);
    }
    this._letterbox = {
      x: Math.round((width - bufW) / 2),
      y: Math.round((height - bufH) / 2),
      w: bufW,
      h: bufH,
    };

    const basePr = this.compatMode ? 1 : Math.min(window.devicePixelRatio, 2);
    let pxW = bufW * basePr * this.renderScale;
    let pxH = bufH * basePr * this.renderScale;
    // 保持宽高比的前提下封顶（超宽/超高屏各按其维度缩放）
    const cap = Math.min(1, this.maxBufferW / pxW, this.maxBufferH / pxH);
    pxW *= cap;
    pxH *= cap;

    this.renderer.setPixelRatio(pxW / bufW);
    // updateStyle=true：canvas 的 CSS 尺寸 = letterbox 逻辑尺寸（不再被 100% 拉伸）
    this.renderer.setSize(bufW, bufH, true);
  }

  /** 设置内部渲染倍率（0.25~1），帧缓冲像素量随平方下降 */
  setRenderScale(scale) {
    this.renderScale = Math.min(1, Math.max(0.25, scale));
    this.applyRenderSize();
  }

  /** 设置帧缓冲分辨率上限（显存封顶值），保持宽高比按两维缩放 */
  setMaxBuffer(w, h) {
    this.maxBufferW = Math.max(320, Math.round(w));
    this.maxBufferH = Math.max(180, Math.round(h));
    this.applyRenderSize();
  }

  /** 阴影独立开关：实际生效 = shadowsOn && !compatMode */
  setShadows(on) {
    this.shadowsOn = !!on;
    this.renderer.shadowMap.enabled = this.shadowsOn && !this.compatMode;
  }

  /**
   * 估算 GPU 帧缓冲 + 阴影贴图内存（MB）。
   * 不含纹理/几何/程序等固定小项；MSAA 按 4x 采样估算。
   */
  estimateGpuMemoryMB() {
    const canvas = this.renderer.domElement;
    const w = canvas.width;
    const h = canvas.height;
    const msaa = this._antialias ? 4 : 1;
    const backbuffer = w * h * 4 * msaa + w * h * 4; // 颜色(×MSAA) + 深度
    const shadow = this.renderer.shadowMap.enabled ? 512 * 512 * 4 : 0;
    return Math.max(1, Math.round((backbuffer + shadow) / (1024 * 1024)));
  }

  /**
   * 视图脏检查：相机位姿、投影矩阵、帧缓冲尺寸任一变化返回 true。
   * 视图固定（本场景默认锁死正视视角）时返回 false，
   * 供悬浮标签跳过无谓的每帧重投影与 DOM 写入。
   */
  viewDirtyCheck() {
    const p = this.camera.position;
    const q = this.camera.quaternion;
    const sig =
      ((p.x * 97) | 0) ^
      ((p.y * 131) | 0) ^
      ((p.z * 193) | 0) ^
      ((q.x * 1000) | 0) ^
      ((q.y * 1000) | 0) ^
      ((q.z * 1000) | 0) ^
      ((this.camera.projectionMatrix.elements[0] * 1000) | 0) ^
      this.renderer.domElement.width ^
      (this.renderer.domElement.height << 3);
    if (sig === this._viewSig) return false;
    this._viewSig = sig;
    return true;
  }

  /**
   * Get 2D Screen projected positions for all agents (for floating tags/labels)
   * 复用预分配数组与 scratch 向量，避免每帧创建临时对象。
   */
  getProjectedAgentPositions() {
    const lb = this._letterbox;
    // 标签对齐 letterbox 后的画布区域（而非整个容器），保证与 3D 画面重合
    const width = lb.w || this.container.clientWidth;
    const height = lb.h || this.container.clientHeight;
    const offsetX = lb.x || 0;
    const offsetY = lb.y || 0;
    const positions = this._projPositions;
    const scratch = this._projScratch;
    let i = 0;

    this.avatars.forEach((avatar, id) => {
      avatar.getHeadWorldPosition(scratch);
      scratch.y += 0.38; // slightly above head
      scratch.project(this.camera);

      const isBehind = scratch.z > 1;
      const screenX = offsetX + (scratch.x * 0.5 + 0.5) * width;
      const screenY = offsetY + (-(scratch.y * 0.5) + 0.5) * height;

      let p = positions[i];
      if (!p) p = positions[i] = { id, screenX: 0, screenY: 0, visible: false };
      p.id = id;
      p.screenX = screenX;
      p.screenY = screenY;
      p.visible = !isBehind && screenX >= offsetX && screenX <= offsetX + width && screenY >= offsetY && screenY <= offsetY + height;
      i += 1;
    });

    positions.length = i;
    return positions;
  }

  animate() {
    // vendored 增补：dispose 后停止 rAF 循环（IDE 里组件可反复挂载/卸载）
    if (this.disposed) return;
    requestAnimationFrame(() => this.animate());

    // 按目标帧率门控渲染：未到时间片直接跳过本帧（渲染、Canvas 屏幕重绘、动画更新全部降频）
    const now = performance.now();
    const frameInterval = 1000 / this.targetFps;
    if (now - this.lastRenderTime < frameInterval) return;

    // 暂停：不更新、不渲染（保留最后一帧画面）。clock delta 在恢复时会被下方 clamp 吸收
    if (!this.running) return;

    const delta = Math.min(this.clock.getDelta(), 0.1); // 限制大跳帧（切后台返回）
    this.lastRenderTime = now;

    // Update submodules
    this.workstations.forEach((ws) => ws.update(delta));
    this.avatars.forEach((avatar) => avatar.update(delta));
    if (this.selectionRing) this.selectionRing.update(delta);

    // 固定视角跟随目标点（替代被移除的 OrbitControls.update 的 lookAt 行为）
    this.camera.lookAt(this.cameraTarget);
    this.renderer.render(this.scene, this.camera);

    // 统计实际帧率（1 秒滚动窗口）
    this.frameCount += 1;
    this.fpsAccum += delta;
    if (this.fpsAccum >= 1) {
      this.measuredFps = Math.round(this.frameCount / this.fpsAccum);
      this.frameCount = 0;
      this.fpsAccum = 0;
    }
  }

  setRunning(running) {
    this.running = !!running;
  }

  setTargetFps(fps) {
    this.targetFps = Math.min(60, Math.max(1, Math.round(fps) || 60));

    // 屏幕重绘与帧率档联动：至少每 4 帧一刷，且不超过 10Hz
    // 60→10Hz / 45→10Hz / 30→7.5Hz / 15→3.75Hz，低帧率档进一步省 CPU
    const redrawSec = Math.max(0.1, 4 / this.targetFps);
    this.workstations.forEach((ws) => {
      ws.primaryScreen.setRedrawInterval(redrawSec);
      ws.secondaryScreen.setRedrawInterval(redrawSec);
    });
  }

  /**
   * 运行时切换兼容模式。
   * 说明：antialias 在创建渲染器时已定，无法热切换；此处应用可热切换项
   * （阴影开关、像素比）。配合 main.js 中的帧率档位联动使用。
   */
  setCompatMode(on) {
    this.compatMode = on;
    this.renderer.shadowMap.enabled = this.shadowsOn && !on;
    this.applyRenderSize();
  }

  dispose() {
    // vendored 增补：置位 disposed 让 animate 循环退出
    this.disposed = true;
    if (this._reframeTimer != null) {
      clearTimeout(this._reframeTimer);
      this._reframeTimer = null;
    }
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.renderer.dispose();
    // 清理容器内残留的 canvas（避免重复挂载时堆积）
    const canvas = this.renderer.domElement;
    if (canvas && canvas.parentNode === this.container) {
      this.container.removeChild(canvas);
    }
  }
}
