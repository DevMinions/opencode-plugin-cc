# Vendored `@opencode-ai/sdk` (client subtree)

This directory contains a **vendored copy of the client-only subtree** of
[`@opencode-ai/sdk`](https://www.npmjs.com/package/@opencode-ai/sdk), pinned to
the version below. It is committed on purpose: the plugin is installed by a
plain file copy (`install.sh` → `~/.claude/plugins/cache/...`) with **no
`npm install` step**, so any runtime dependency must already be on disk.

- **Pinned version:** `1.17.9` (kept in lockstep with the OpenCode CLI/server —
  the SDK and the `opencode` binary share the same release tag).
- **What's here:** only the `.js` files reachable from the package's
  `exports["./client"]` entry (`dist/client.js` + its `dist/gen/**` imports).
  The `./server` entry and its one dependency (`cross-spawn`) are intentionally
  **not** vendored — we spawn `opencode serve` ourselves and use the SDK purely
  as a typed HTTP client. This subtree has **zero external runtime deps**.
- **Imported by:** `../../lib/opencode-server.mjs` via
  `import { createOpencodeClient } from "./vendor/opencode-sdk/client.js"`.

## How to update (when bumping the OpenCode version)

From the repo root, with the matching version installed:

```bash
npm install --no-save @opencode-ai/sdk@<new-version>

# Recompute the .js closure of the ./client entry and re-vendor it:
node -e '
const fs=require("fs"),path=require("path");
const root=path.resolve("node_modules/@opencode-ai/sdk/dist");
const dest=path.resolve("plugins/opencode/scripts/vendor/opencode-sdk");
const seen=new Set();
(function visit(f){
  if(seen.has(f))return; seen.add(f);
  const src=fs.readFileSync(f,"utf8");
  for(const m of src.matchAll(/(?:import|export)[^;]*?from\s*["\x27]([^"\x27]+)["\x27]/g)){
    if(m[1].startsWith(".")){let t=path.resolve(path.dirname(f),m[1]);if(!t.endsWith(".js"))t+=".js";visit(t);}
    else throw new Error("unexpected external import: "+m[1]); // /client must stay zero-dep
  }
})(path.join(root,"client.js"));
fs.rmSync(dest,{recursive:true,force:true});
for(const f of seen){const rel=path.relative(root,f);const out=path.join(dest,rel);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(f,out);}
console.log("vendored",seen.size,"files");
'
```

Then update the pinned version above, the `devDependencies` entry in the root
`package.json`, and re-run `npm test` + a live `/opencode:setup` smoke check.
If the updater throws `unexpected external import`, the `./client` entry gained
a dependency — reassess vendoring vs bundling before shipping.
