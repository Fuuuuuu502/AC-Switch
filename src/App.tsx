import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import clsx from "clsx";

type Provider = {
  id: string;
  kind: "opencode_go" | "custom_openai" | string;
  name: string;
  endpoint: string;
  model: string;
  reasoningEffort: string;
  hasKey: boolean;
};

type AppConfig = {
  activeProviderId: string;
  providers: Provider[];
};

type AppStatus = {
  accioRunning: boolean;
  relayOk: boolean;
  bridgeOk: boolean;
  activeProviderId: string;
  hook: string;
};

const OFFICIAL: Provider = {
  id: "official",
  kind: "official",
  name: "Accio 官方原生认证",
  endpoint: "phoenix-gw.alibaba.com",
  model: "官方积分模型",
  reasoningEffort: "-",
  hasKey: false,
};

const KIND_LABEL: Record<string, string> = {
  official: "官方",
  opencode_go: "OpenCode Go",
  custom_openai: "自定义 API",
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
    hasKey: false,
    apiKey: "",
  };
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<(Provider & { apiKey: string }) | null>(null);

  const providers = useMemo(() => [OFFICIAL, ...(config?.providers || [])], [config]);

  async function refresh() {
    const [nextConfig, nextStatus] = await Promise.all([
      invoke<AppConfig>("get_config"),
      invoke<AppStatus>("get_status"),
    ]);
    setConfig(nextConfig);
    setStatus(nextStatus);
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    const timer = setInterval(() => {
      invoke<AppStatus>("get_status").then(setStatus).catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function enable(id: string) {
    await run(async () => {
      const next = await invoke<AppStatus>("apply_provider", { id });
      setStatus(next);
      await refresh();
    });
  }

  async function saveProvider() {
    if (!editing) return;
    const savedId = editing.id;
    const shouldApply = Boolean(savedId) && savedId === activeId;
    await run(async () => {
      const next = await invoke<AppConfig>("upsert_provider", {
        input: {
          id: editing.id || null,
          kind: editing.kind,
          name: editing.name,
          endpoint: editing.endpoint,
          model: editing.model,
          reasoningEffort: editing.reasoningEffort,
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
    await run(async () => {
      const next = await invoke<AppConfig>("delete_provider", { id });
      setConfig(next);
    });
  }

  const activeId = status?.activeProviderId || config?.activeProviderId || "official";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <div className="text-lg font-semibold tracking-tight">Accio Switch</div>
          <div className="mt-1 text-xs text-gray-400">
            Accio {status?.accioRunning ? "运行中" : "未运行"} · 中继 {status?.relayOk ? "在线" : "离线"} · 模型桥 {status?.bridgeOk ? "在线" : "离线"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-sm hover:bg-white/5"
            onClick={() => run(refresh)}
            disabled={busy}
          >
            <RefreshCw size={14} /> 刷新
          </button>
          <button
            className="inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-indigo-500"
            onClick={() => run(() => invoke("restart_accio").then(() => refresh()))}
            disabled={busy}
          >
            <Power size={14} /> 重启 Accio
          </button>
        </div>
      </header>

      {error ? (
        <div className="mx-5 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <main className="flex-1 overflow-auto px-5 py-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-sm text-gray-300">供应商</div>
          <div className="flex gap-2">
            <button
              className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-sm hover:bg-white/5"
              onClick={() => setEditing(emptyForm("opencode_go"))}
            >
              <Plus size={14} /> OpenCode Go
            </button>
            <button
              className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-sm hover:bg-white/5"
              onClick={() => setEditing(emptyForm("custom_openai"))}
            >
              <Plus size={14} /> 自定义 API
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {providers.map((provider) => {
            const active = provider.id === activeId;
            return (
              <div
                key={provider.id}
                className={clsx(
                  "rounded-2xl border bg-card p-4",
                  active ? "border-indigo-400/70" : "border-line",
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-base font-medium">{provider.name}</div>
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-gray-300">
                        {KIND_LABEL[provider.kind] || provider.kind}
                      </span>
                      {active ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                          <Check size={12} /> 使用中
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 text-xs text-gray-400">
                      {provider.model} · {provider.reasoningEffort} · {provider.endpoint}
                    </div>
                    {provider.id !== "official" ? (
                      <div className="mt-1 text-xs text-gray-500">
                        {provider.hasKey ? "Key 已保存在钥匙串" : "未配置 API Key"}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-gray-500">不经过本地模型桥，使用 Accio 官方积分</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {provider.id !== "official" ? (
                      <>
                        <button
                          className="rounded-lg border border-line p-2 hover:bg-white/5"
                          onClick={() => setEditing({ ...provider, apiKey: "" })}
                        >
                          <Settings2 size={16} />
                        </button>
                        <button
                          className="rounded-lg border border-line p-2 hover:bg-white/5"
                          onClick={() => removeProvider(provider.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    ) : null}
                    <button
                      className={clsx(
                        "rounded-lg px-3 py-2 text-sm",
                        active ? "bg-white/10 text-gray-300" : "bg-accent text-white hover:bg-indigo-500",
                      )}
                      disabled={busy || active}
                      onClick={() => enable(provider.id)}
                    >
                      {busy ? <Loader2 className="animate-spin" size={14} /> : active ? "已启用" : "启用"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {editing ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-panel p-5">
            <div className="mb-4 text-base font-medium">{editing.id ? "编辑供应商" : "添加供应商"}</div>
            <div className="space-y-3 text-sm">
              <label className="block">
                <div className="mb-1 text-gray-400">名称</div>
                <input
                  className="w-full rounded-lg border border-line bg-card px-3 py-2"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label className="block">
                <div className="mb-1 text-gray-400">接口地址</div>
                <input
                  className="w-full rounded-lg border border-line bg-card px-3 py-2"
                  value={editing.endpoint}
                  onChange={(e) => setEditing({ ...editing, endpoint: e.target.value })}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <div className="mb-1 text-gray-400">模型</div>
                  <input
                    className="w-full rounded-lg border border-line bg-card px-3 py-2"
                    value={editing.model}
                    onChange={(e) => setEditing({ ...editing, model: e.target.value })}
                  />
                </label>
                <label className="block">
                  <div className="mb-1 text-gray-400">思考档位</div>
                  <select
                    className="w-full rounded-lg border border-line bg-card px-3 py-2"
                    value={editing.reasoningEffort}
                    onChange={(e) => setEditing({ ...editing, reasoningEffort: e.target.value })}
                  >
                    {["disabled", "low", "high", "max"].map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1 text-[11px] text-gray-500">
                    Accio 里的模型名来自正在运行的中继。改档位后点保存（当前供应商会立刻热更新），或再点一次启用。
                  </div>
                </label>
              </div>
              <label className="block">
                <div className="mb-1 text-gray-400">API Key（留空表示不改）</div>
                <input
                  type="password"
                  className="w-full rounded-lg border border-line bg-card px-3 py-2"
                  value={editing.apiKey}
                  placeholder={editing.hasKey ? "已保存，输入新值可覆盖" : "sk-..."}
                  onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-lg border border-line px-3 py-2 text-sm" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="rounded-lg bg-accent px-3 py-2 text-sm text-white" onClick={saveProvider} disabled={busy}>
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
