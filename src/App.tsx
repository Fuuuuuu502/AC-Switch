import { useEffect, useMemo, useState, useRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  ArrowRight,
  Info,
  X,
  Cable,
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Settings2,
  Shield,
  Trash2,
  Image as ImageIcon,
  Waypoints,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import { endpointForProtocol, endpointError } from "./provider-endpoint";
import presets from "./provider-presets.json";
import appIcon from "./assets/accio-switch.png";

type Provider = {
  id: string;
  kind: "opencode_go" | "custom_openai" | string;
  name: string;
  endpoint: string;
  model: string;
  reasoningEffort: string;
  apiProtocol?: string;
  hasKey: boolean;
};

type ImageChannel = {
  enabled: boolean;
  endpoint: string;
  model: string;
  hasKey: boolean;
};

type AppConfig = {
  activeProviderId: string;
  providers: Provider[];
  imageChannel?: ImageChannel;
};

type AppStatus = {
  initializing?: boolean;
  runtimeError?: string;
  accioRunning: boolean;
  relayOk: boolean;
  bridgeOk: boolean;
  activeProviderId: string;
  hook: string;
  bridgeAuthType?: string;
  bridgeApiKeyConfigured?: boolean;
  accioRestarted?: boolean;
  accioUsingRelay?: boolean;
};

const OFFICIAL: Provider = {
  id: "official",
  kind: "official",
  name: "Accio 官方原生认证",
  endpoint: "phoenix-gw.alibaba.com",
  model: "官方积分模型",
  reasoningEffort: "-",
  apiProtocol: "chat_completions",
  hasKey: false,
};

const KIND_LABEL: Record<string, string> = {
  official: "官方",
  opencode_go: "Zen Go",
  custom_openai: "兼容接口",
};

const EFFORT_LABEL: Record<string, string> = {
  disabled: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最强",
  "-": "官方默认",
};

function emptyForm(kind: "opencode_go" | "custom_openai"): Provider & { apiKey: string } {
  if (kind === "opencode_go") {
    return {
      id: "",
      kind,
      name: "OpenCode Go",
      endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      apiProtocol: "chat_completions",
      hasKey: false,
      apiKey: "",
    };
  }
  return {
    id: "",
    kind,
    name: "自定义 OpenAI 兼容",
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "llama3",
    reasoningEffort: "disabled",
    apiProtocol: "chat_completions",
    hasKey: false,
    apiKey: "",
  };
}

function KindMark({ kind }: { kind: string }) {
  return <div className={clsx("kind-mark", `kind-${kind}`)}>{kind === "official" ? <Shield size={21} strokeWidth={1.6} /> : kind === "opencode_go" ? <Zap size={21} strokeWidth={1.6} /> : <Cable size={21} strokeWidth={1.6} />}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}</label>;
}

function TextField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx("text-field", props.className)} />;
}

function Modal({ title, description, onClose, busy, children }: { title: string; description: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); dialog?.querySelector<HTMLElement>("input, select, textarea")?.focus(); return () => dialog?.close(); }, []);
  return <dialog className="modal" ref={ref} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget || busy) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}><div className="modal-heading"><div><h2 id={titleId}>{title}</h2><p>{description}</p></div><button type="button" className="icon-button" aria-label="关闭窗口" disabled={busy} onClick={onClose}><X size={19} /></button></div>{children}</dialog>;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<(Provider & { apiKey: string }) | null>(null);
  const [editingImage, setEditingImage] = useState<(ImageChannel & { apiKey: string }) | null>(null);
  const [choosingProvider, setChoosingProvider] = useState(false);
  const editingPreset = presets.find(p => p.endpoint === editing?.endpoint && editing?.apiProtocol === "chat_completions");
  const [pendingDelete, setPendingDelete] = useState("");

  const providers = useMemo(() => [OFFICIAL, ...(config?.providers || [])], [config]);
  const busy = Boolean(busyAction) || !status || Boolean(status.initializing);
  const activeId = status?.activeProviderId || config?.activeProviderId || "official";
  const activeProvider = providers.find((item) => item.id === activeId) || OFFICIAL;

  async function refresh() {
    const [nextConfig, nextStatus] = await Promise.all([
      invoke<AppConfig>("get_config"),
      invoke<AppStatus>("get_status"),
    ]);
    setConfig(nextConfig);
    setStatus(nextStatus);
  }

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await invoke<AppStatus>("get_status");
        if (!disposed) setStatus(next);
      } catch { /* A user action reports errors; background polling retries later. */ }
      if (!disposed) timer = setTimeout(poll, 5000);
    }
    invoke<AppConfig>("get_config").then(next => { if (!disposed) setConfig(next); }).catch(e => { if (!disposed) setError(String(e)); });
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);

  async function run<T>(action: string, fn: () => Promise<T>) {
    setBusyAction(action);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyAction("");
    }
  }

  async function enable(id: string) {
    await run(`enable:${id}`, async () => {
      const next = await invoke<AppStatus>("apply_provider", { id });
      setStatus(next);
      await refresh();
    });
  }

  async function saveProvider() {
    if (!editing) return;
    const validationError = endpointError(editing.endpoint, editing.apiProtocol || "chat_completions");
    if (validationError) { setError(validationError); return; }
    const savedId = editing.id;
    const shouldApply = Boolean(savedId) && savedId === activeId;
    await run("save", async () => {
      const next = await invoke<AppConfig>("upsert_provider", {
        input: {
          id: editing.id || null,
          kind: editing.kind,
          name: editing.name,
          endpoint: editing.endpoint.trim(),
          model: editing.model,
          reasoningEffort: editing.reasoningEffort,
          apiProtocol: editing.apiProtocol || "chat_completions",
          apiKey: editing.apiKey || null,
        },
      });
      setConfig(next);
      setEditing(null);
      if (shouldApply) {
        const nextStatus = await invoke<AppStatus>("apply_provider", { id: savedId });
        setStatus(nextStatus);
      }
    });
  }

  async function removeProvider(id: string) {
    await run(`delete:${id}`, async () => {
      const next = await invoke<AppConfig>("delete_provider", { id });
      setConfig(next);
      setPendingDelete("");
    });
  }

  async function saveImageChannel() {
    if (!editingImage) return;
    await run("save-image", async () => {
      const next = await invoke<AppConfig>("upsert_image_channel", {
        input: {
          enabled: editingImage.enabled,
          endpoint: editingImage.endpoint,
          model: editingImage.model,
          apiKey: editingImage.apiKey || null,
        },
      });
      setConfig(next);
      setEditingImage(null);
    });
  }

  const imageChannel = config?.imageChannel || {
    enabled: false,
    endpoint: "",
    model: "",
    hasKey: false,
  };

  const missingRequiredKey = status?.bridgeAuthType === "api_key" && status.bridgeApiKeyConfigured === false;
  const backendReady = Boolean(!missingRequiredKey && status?.relayOk && (activeId === "official" || status.bridgeOk) && !status.runtimeError);
  const connectionReady = Boolean(backendReady && status?.accioRunning && status.accioUsingRelay);
  const connectionText = status?.initializing
    ? "正在启动"
    : !backendReady
      ? status ? "后端未就绪" : "正在检查"
      : !status?.accioRunning
        ? "等待 Accio"
        : !status.accioUsingRelay
          ? "Accio 尚未接入"
          : "本地通道已接入";
  const message = error || status?.runtimeError;

  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img src={appIcon} alt="" width="34" height="34" draggable={false} data-tauri-drag-region />
          <span data-tauri-drag-region>Accio Switch</span>
          <span className="brand-divider" data-tauri-drag-region />
          <span className="brand-caption" data-tauri-drag-region>模型连接，轻松切换</span>
        </div>
        <div className="titlebar-actions">
          <button className="button button-quiet" onClick={() => run("refresh", refresh)} disabled={busy} aria-label="刷新连接状态">
            <RefreshCw size={15} className={busyAction === "refresh" ? "spin" : ""} />
            <span>刷新</span>
          </button>
          <button className="button button-quiet" onClick={() => run("restart", () => invoke("restart_accio").then(() => refresh()))} disabled={busy}>
            {busyAction === "restart" ? <Loader2 size={15} className="spin" /> : <Power size={15} />}重启 Accio
          </button>
        </div>
      </header>

      <main className="workspace">
        <div className="page-heading">
          <div><div className="eyebrow">模型控制台</div><h1>管理你的模型通道</h1><p>选择对话模型，或配置独立的图片通道。</p></div>
          <span className={clsx("connection-label", status?.accioRunning && "is-online")}><span className="status-dot" />Accio {status?.accioRunning ? "运行中" : "未运行"}</span>
        </div>

        {message ? <div className="notice notice-error" role="alert"><AlertCircle size={18} /><div><strong>连接需要处理</strong><p>{message}</p></div></div> : null}
        {activeId !== "official" && status?.bridgeOk && status.bridgeAuthType !== "none" && status.bridgeApiKeyConfigured === false ? <div className="notice notice-warning" role="alert"><KeyRound size={18} /><p>当前通道缺少 API Key。请编辑供应商，保存 Key 后重新启用。</p></div> : null}

        <section className={clsx("current-channel", connectionReady && "is-ready")} aria-label="当前对话通道">
          <div className="current-channel-main">
            <span className="current-icon"><Waypoints size={25} strokeWidth={1.5} /></span>
            <div className="current-copy"><div className="eyebrow">当前对话通道</div><h2>{activeProvider.name}</h2><p title={activeProvider.model}>{activeProvider.model}{activeId !== "official" ? ` · ${EFFORT_LABEL[activeProvider.reasoningEffort] || activeProvider.reasoningEffort}` : ""}</p></div>
          </div>
          <span className={clsx("state-badge", connectionReady ? "state-ready" : "state-idle")}><span className="status-dot" />{connectionText}</span>
        </section>

        <section className="providers-section" aria-labelledby="providers-title">
          <div className="section-heading"><div className="section-title"><h2 id="providers-title">对话模型</h2><span className="count">{providers.length}</span></div><div className="section-actions">
            <button className="button button-primary" disabled={busy} onClick={() => setChoosingProvider(true)}><Plus size={15} />添加供应商</button>
            <button className="button button-secondary" disabled={busy} onClick={() => setEditing(emptyForm("custom_openai"))}><Plus size={15} />自定义 API</button>
          </div></div>
          <div className="provider-list">
            {providers.map((provider) => {
              const selected = provider.id === activeId;
              const confirming = pendingDelete === provider.id;
              const requiresKey = provider.kind === "opencode_go" || presets.some(p => p.endpoint === provider.endpoint);
              const missingKey = requiresKey && !provider.hasKey && !selected;
              return <article key={provider.id} className={clsx("provider-row", selected && "is-selected")}>
                <KindMark kind={provider.kind} />
                <div className="provider-content">
                  <div className="provider-name"><h3>{provider.name}</h3><span className="provider-kind">{KIND_LABEL[provider.kind] || provider.kind}</span>{selected ? <span className="selected-label"><Check size={12} />已选择</span> : null}</div>
                  <div className="provider-details"><span className="model-name" title={provider.model}>{provider.model}</span>{provider.id !== "official" ? <><span className="detail-divider" /><span>{EFFORT_LABEL[provider.reasoningEffort] || provider.reasoningEffort}</span><span className="detail-divider" /><span>{provider.apiProtocol === "responses" ? "Responses" : "Chat Completions"}</span></> : null}</div>
                  {provider.id !== "official" ? <div className={clsx("credential-label", provider.hasKey ? "credential-saved" : requiresKey ? "credential-missing" : "")}><KeyRound size={11} />{provider.hasKey ? "凭据已保存" : requiresKey ? "待配置 API Key" : "未配置 Key · 支持本地接口"}</div> : <div className="credential-label">使用 Accio 官方账户与积分</div>}
                </div>
                <div className="provider-actions">
                  {confirming ? <><button className="button button-quiet" disabled={busy} onClick={() => setPendingDelete("")}>取消</button><button className="button button-danger" disabled={busy} onClick={() => removeProvider(provider.id)}>{busyAction === `delete:${provider.id}` ? <Loader2 size={14} className="spin" /> : null}确认删除</button></> : <>
                    {provider.id !== "official" ? <div className="edit-actions"><button className="icon-button" disabled={busy} aria-label={`编辑 ${provider.name}`} title="编辑供应商" onClick={() => setEditing({ ...provider, apiKey: "" })}><Settings2 size={16} /></button><button className="icon-button delete-button" disabled={busy} aria-label={`删除 ${provider.name}`} title="删除供应商" onClick={() => setPendingDelete(provider.id)}><Trash2 size={15} /></button></div> : null}
                    <button className={clsx("button switch-button", selected ? "button-selected" : "button-secondary")} disabled={busy || missingKey} title={missingKey ? "请先填写 API Key" : selected ? "重新应用当前供应商" : "切换到此供应商；必要时重启 Accio"} onClick={() => enable(provider.id)}>{busyAction === `enable:${provider.id}` ? <Loader2 size={14} className="spin" /> : selected ? <RefreshCw size={13} /> : <ArrowRight size={14} />}{selected ? "重新启用" : "启用"}</button>
                  </>}
                </div>
              </article>;
            })}
          </div>
          <p className="section-note"><Info size={12} />已连接时热切换通道；未连接时会启动或重启 Accio。</p>
        </section>

        <section className="image-section" aria-labelledby="image-title">
          <div className="section-heading"><div className="section-title"><h2 id="image-title">图片通道</h2><span className="section-caption">独立于对话模型</span></div></div>
          <div className={clsx("image-channel", imageChannel.enabled && "is-enabled")}>
            <div className="image-mark"><ImageIcon size={23} strokeWidth={1.5} /></div>
            <div className="image-copy"><div className="provider-name"><h3>{imageChannel.model || "独立图片模型"}</h3><span className="small-state">{imageChannel.enabled ? "已开启" : "未开启"}</span></div><p>{imageChannel.enabled ? (imageChannel.hasKey ? "生图与改图使用独立凭据" : "生图与改图复用对话 Key") : "单独配置生图与改图，不占用对话模型。"}</p>{activeId === "official" ? <p className="image-footnote">当前为官方模式，图片请求仍使用官方通道。</p> : null}</div>
            <div className="image-actions"><button className="button button-quiet" disabled={busy} onClick={() => setEditingImage({ ...imageChannel, apiKey: "" })}><Settings2 size={15} />设置</button><button className={clsx("toggle", imageChannel.enabled && "is-on")} role="switch" aria-checked={imageChannel.enabled} aria-label="启用独立图片通道" disabled={busy} onClick={() => {
              if (!imageChannel.enabled && !imageChannel.model) { setEditingImage({ ...imageChannel, enabled: true, apiKey: "" }); return; }
              run("toggle-image", async () => { const next = await invoke<AppConfig>("upsert_image_channel", { input: { enabled: !imageChannel.enabled, endpoint: imageChannel.endpoint, model: imageChannel.model, apiKey: null } }); setConfig(next); });
            }}><span>{busyAction === "toggle-image" ? <Loader2 size={12} className="spin" /> : null}</span></button></div>
          </div>
        </section>
        <footer className="workspace-footer"><span><Shield size={12} />凭据保存在本机</span><span>关闭窗口后，仍可通过托盘切换</span></footer>
      </main>

      {choosingProvider ? <Modal title="选择供应商" description="接口与默认模型已配好，下一步填写 API Key。" onClose={() => setChoosingProvider(false)} busy={busy}>
        <div className="preset-grid">{presets.map(preset => <button key={preset.id} className="preset-card" onClick={() => {
          setEditing({ id: "", kind: preset.kind, name: preset.name, endpoint: preset.endpoint, model: preset.models[0], reasoningEffort: preset.reasoningEffort, apiProtocol: "chat_completions", hasKey: false, apiKey: "" });
          setChoosingProvider(false);
        }}><strong>{preset.name}</strong><span>{preset.models[0]}</span><ArrowRight size={16} /></button>)}</div>
        <div className="modal-footer"><button className="button button-secondary" onClick={() => { setChoosingProvider(false); setEditing(emptyForm("custom_openai")); }}>自定义 API</button></div>
      </Modal> : null}

      {editing ? <Modal title={editing.id ? "编辑供应商" : "添加供应商"} description={editingPreset ? `${editingPreset.name} · ${editingPreset.note}` : "连接 OpenAI 兼容服务，也支持本地模型。"} onClose={() => setEditing(null)} busy={busy}>
        <form onSubmit={(event) => { event.preventDefault(); saveProvider(); }}>
          <div className="modal-fields">
            {error ? <div className="notice notice-error" role="alert"><AlertCircle size={16} /><p>{error}</p></div> : null}
            <Field label="API Key"><TextField required={Boolean(editingPreset && !editing.hasKey)} type="password" autoComplete="off" value={editing.apiKey} placeholder={editing.hasKey ? "已保存 · 留空保持不变" : "sk-..."} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} /><span className="field-help">{editingPreset ? "填写所选平台的 API Key。" : "本地模型可留空。"}已有凭据留空不会修改。</span></Field>
            {editingPreset ? <div className="form-note"><Info size={14} />已匹配 Chat Completions 协议和完整请求地址，通常只需填写 Key，无需修改高级设置。</div> : null}
            {editingPreset ? <Field label="对话模型"><div className="select-wrap"><select value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })}>{Array.from(new Set([...editingPreset.models, editing.model])).map(model => <option key={model} value={model}>{model}</option>)}</select><ChevronDown size={14} /></div><span className="field-help">已选择默认模型，可直接保存。其他模型可在高级设置填写。</span></Field> : null}
            <details className="advanced-settings" open={editingPreset ? undefined : true}><summary>高级设置 · 接口、模型与协议</summary><div className="advanced-fields">
            <Field label="供应商名称"><TextField required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="完整请求地址"><TextField required value={editing.endpoint} spellCheck={false} onChange={(e) => setEditing({ ...editing, endpoint: e.target.value })} /><span className="field-help">填写实际接收请求的完整 URL，不是官网或 SDK 基础地址。{editing.apiProtocol === "responses" ? "通常以 /responses 结尾。" : "通常以 /chat/completions 结尾。"}</span></Field>
            <div className="form-columns"><Field label="模型名称"><TextField required value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} /></Field><Field label="思考强度"><div className="select-wrap"><select value={editing.reasoningEffort} onChange={(e) => setEditing({ ...editing, reasoningEffort: e.target.value })}>{Array.from(new Set([...(editingPreset?.efforts || ["disabled", "low", "medium", "high", "xhigh", "max"]), editing.reasoningEffort])).map(item => <option key={item} value={item}>{EFFORT_LABEL[item] || item}</option>)}</select><ChevronDown size={14} /></div><span className="field-help">可用强度取决于模型和代理支持；极高、最强通常需要更长时间和更多额度。</span></Field></div>
            <Field label="对话协议"><div className="select-wrap"><select value={editing.apiProtocol || "chat_completions"} onChange={(e) => { setError(""); setEditing({ ...editing, apiProtocol: e.target.value, endpoint: endpointForProtocol(editing.endpoint, e.target.value) }); }}><option value="chat_completions">Chat Completions</option><option value="responses">Responses API</option></select><ChevronDown size={14} /></div><span className="field-help">切换协议会同步替换标准接口路径；自定义路径需自行核对。当前不支持 Anthropic Messages（/anthropic）。</span></Field>
            </div></details>
            <div className="form-note"><Info size={14} />保存当前供应商后，模型与思考设置会立即应用。</div>
          </div><div className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="button button-primary" disabled={busy}>{busyAction === "save" ? <Loader2 size={15} className="spin" /> : <Check size={15} />}保存供应商</button></div>
        </form>
      </Modal> : null}

      {editingImage ? <Modal title="图片通道设置" description="为 Accio 的生图与改图配置专属模型。" onClose={() => setEditingImage(null)} busy={busy}>
        <form onSubmit={(event) => { event.preventDefault(); saveImageChannel(); }}><div className="modal-fields">
          {error ? <div className="notice notice-error" role="alert"><AlertCircle size={16} /><p>{error}</p></div> : null}
          <label className="toggle-field"><span><strong>启用独立图片模型</strong><small>对话仍使用当前文字供应商</small></span><input type="checkbox" checked={editingImage.enabled} onChange={(e) => setEditingImage({ ...editingImage, enabled: e.target.checked })} /></label>
          <Field label="图片模型"><TextField required={editingImage.enabled} value={editingImage.model} placeholder="gpt-image-1" onChange={(e) => setEditingImage({ ...editingImage, model: e.target.value })} /></Field>
          <Field label="图片接口"><TextField value={editingImage.endpoint} spellCheck={false} placeholder="https://api.openai.com/v1/images/generations" onChange={(e) => setEditingImage({ ...editingImage, endpoint: e.target.value })} /><span className="field-help">留空使用 OpenAI 默认图片接口。</span></Field>
          <Field label="独立 API Key"><TextField type="password" autoComplete="off" value={editingImage.apiKey} placeholder={editingImage.hasKey ? "已保存 · 留空保持不变" : "可选 · 未配置时复用对话 Key"} onChange={(e) => setEditingImage({ ...editingImage, apiKey: e.target.value })} /><span className="field-help">已有凭据留空不会修改。</span></Field>
        </div><div className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setEditingImage(null)}>取消</button><button className="button button-primary" disabled={busy}>{busyAction === "save-image" ? <Loader2 size={15} className="spin" /> : <Check size={15} />}保存设置</button></div></form>
      </Modal> : null}
    </div>
  );
}
