import path from "node:path";
import { pathToFileURL } from "node:url";

import { fixturePaths, generateFixtureTree } from "./fixture-contract.mjs";

export async function main(arguments_) {
  const root = arguments_[0] ? path.resolve(arguments_[0]) : fixturePaths.projectRoot;
  const result = await generateFixtureTree(root);
  process.stdout.write(`${JSON.stringify({ root, ...result })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
