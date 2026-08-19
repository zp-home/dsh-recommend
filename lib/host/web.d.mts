import { t as RegistrySyncConfig } from "./sync-ldYwm8GB.mjs";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/web.d.ts
declare const name = "dsh-recommend-web";
declare const inject: string[];
interface Config extends RegistrySyncConfig {
  /** 可选：安装目标 profile 名；缺省为 web（浏览器半所在的 profile）。 */
  installProfile?: string;
}
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=web.d.mts.map