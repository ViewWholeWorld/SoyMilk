import { z } from "zod";
import { audit } from "../audit.ts";
import { invalidateModelCache } from "../editorial/models.ts";
import { deleteModelConnection, modelConfiguration, saveModelConnection, selectModelConnection } from "../providers/model-config.ts";
import { cancelCodexLogin, codexLoginStatus, codexModels, codexStatus, logoutCodex, startCodexLogin } from "../providers/codex.ts";

export { modelConfiguration, codexStatus, codexModels };
export async function saveConnection(input: unknown, actor: string) {
  const c = await saveModelConnection(input);
  invalidateModelCache();
  await audit(actor, "models.connection.save", `connection:${c.id}`, "后台保存模型连接", null, c);
  return c;
}
export async function activateConnection(input: unknown, actor: string) {
  const b = z.object({ id: z.string().uuid().nullable() }).parse(input);
  const before = (await modelConfiguration()).active;
  const result = await selectModelConnection(b.id);
  invalidateModelCache();
  await audit(actor, "models.connection.activate", "models.default", "更换默认连接", { active: before }, result);
  return result;
}
export async function removeConnection(id: string, actor: string) {
  z.string().uuid().parse(id);
  const before = await deleteModelConnection(id);
  invalidateModelCache();
  if (before) await audit(actor, "models.connection.delete", `connection:${id}`, "删除模型连接", before, null);
  return { deleted: !!before };
}
export async function connectCodex(owner: string, actor: string, input: unknown = {}) {
  const { restart } = z.object({ restart: z.boolean().default(false) }).parse(input);
  const result = await startCodexLogin(owner, undefined, restart);
  await audit(actor, "models.codex.login.start", "codex", restart ? "取消旧授权并重新发起设备授权" : "网页发起设备授权", null, { login: result.id });
  return result;
}
const logged = new Set<string>();
export async function loginStatus(owner: string, id: string, actor: string) {
  const r = codexLoginStatus(owner, id);
  if (r.state === "success" && !logged.has(id)) {
    logged.add(id);
    if (logged.size > 100) logged.delete(logged.values().next().value!);
    await audit(actor, "models.codex.login.completed", "codex", "网页授权成功", null, { connected: true });
  }
  return r;
}
export async function cancelLogin(owner: string, id: string, actor: string) {
  const r = await cancelCodexLogin(owner, id);
  await audit(actor, "models.codex.login.cancel", "codex", "取消网页授权", null, null);
  return r;
}
export async function disconnectCodex(actor: string) {
  const r = await logoutCodex();
  await audit(actor, "models.codex.logout", "codex", "断开 Codex 账号", null, r);
  return r;
}
