import { t as RegistrySyncConfig } from "./sync-ldYwm8GB.mjs";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/index.d.ts
declare const name = "dsh-recommend";
declare const inject: string[];
interface Config extends RegistrySyncConfig {}
declare function apply(ctx: Context, config: Config): void;
/**
 * 同义扩展组：goal 里的词命中某组任一同义词时，整组同义词参与检索。
 * 覆盖 DSH 插件生态的高频语义（中英 + 常见别名）。
 */
declare const SYNONYM_GROUPS: Record<string, string[]>;
//#endregion
export { Config, SYNONYM_GROUPS, apply, inject, name };
//# sourceMappingURL=index.d.mts.map