import { register } from "node:module";

await register("./ts-ext-hooks.mjs", import.meta.url);
