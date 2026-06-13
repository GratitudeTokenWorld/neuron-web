# patches/

`patch-package` applies any `*.patch` file here on `postinstall`. Files renamed to
`*.patch.disabled` are **preserved but NOT applied** (kept for future use).

## `@helia+bitswap+3.1.4.patch.disabled`

Carried over from the old **neuronchain** repo. It patches `@helia/bitswap`'s
`network.js`. As of the engine migration, `@helia/bitswap` is **no longer in the
dependency tree** (nothing imports it; `npm ls @helia/bitswap` is empty), so the
patch is disabled — leaving it active makes `patch-package` error with
"Patch file found for package bitswap which is not present".

**It is kept on purpose** for the upcoming content-storage layer, which may
reintroduce a Helia/bitswap dependency.

### To re-enable (when @helia/bitswap becomes a dependency again)
1. Confirm it's installed: `npm ls @helia/bitswap`.
2. Rename it back: `@helia+bitswap+3.1.4.patch.disabled` → `@helia+bitswap+3.1.4.patch`.
3. Re-check that the patch still applies against the installed version (the `3.1.4`
   in the filename must match; if the version differs, regenerate with
   `npx patch-package @helia/bitswap`).
4. `npm install` (postinstall applies it).

### To delete (if the new content layer does NOT use Helia/bitswap)
Once the content-storage design is finalized and confirmed not to depend on
`@helia/bitswap` (compare against how neuronchain used it), delete this file.
