// Copy the built plugin into a vault for local testing:
//   OBSIDIAN_VAULT=/path/to/vault npm run deploy
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const vault = process.env.OBSIDIAN_VAULT;
if (!vault || !existsSync(join(vault, ".obsidian"))) {
	console.error("Set OBSIDIAN_VAULT to your vault folder (the one containing .obsidian).");
	process.exit(1);
}

const { id } = JSON.parse(readFileSync("manifest.json", "utf8"));
const dir = join(vault, ".obsidian", "plugins", id);
mkdirSync(dir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(file, join(dir, file));
}
console.log(`Copied main.js, manifest.json and styles.css to ${dir}`);
