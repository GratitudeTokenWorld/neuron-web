/// <reference types="vite/client" />

// Gives `import … from '…?raw'` a type. Needed by capture-guide.test.ts, which
// asserts index.html's markup against the CSS contracts that reveal the capture
// guide — `node:fs` would be the obvious way to read the file, but @types/node
// is scoped to tsconfig.storage.json (src/storage is excluded from the app
// project), so importing it here would add errors to the app-layer baseline.
