// This is a reviewed download catalog, not renderer-provided configuration.
// Pins verified against the official release/registry on 2026-09-23.
const OLLAMA_URL = "http://127.0.0.1:42816";
const RUNTIME = Object.freeze({
  version: "0.34.3",
  url: "https://github.com/ollama/ollama/releases/download/v0.34.3/ollama-darwin.tgz",
  sha256: "2c45865f94bce0d4d1d2567603dd2fdacaf375585220a175aa4800105193d36e",
  sizeBytes: 158600511,
  license: "MIT",
});
const layers = (entries) => Object.freeze(entries.map(([digest, sizeBytes]) => Object.freeze({ digest, sizeBytes })));
// Kept for approved existing installs and explicit developer comparisons.
// More RAM alone is not evidence that 4B is a better Mike starter.
const MODEL = Object.freeze({
  id: "ollama/qwen3.5:4b",
  tag: "qwen3.5:4b",
  name: "Qwen 3.5 4B",
  license: "Apache-2.0",
  licenseUrl: "https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE",
  sourceUrl: "https://ollama.com/library/qwen3.5:4b",
  digest: "2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd",
  downloadBytes: 3389983735,
  layers: layers([
    ["81fb60c7daa80fc1123380b98970b320ae233409f0f71a72ed7b9b0d62f40490", 3389971840],
    ["7339fa418c9ad3e8e12e74ad0fd26a9cc4be8703f9c110728a992b193be85cb2", 11355],
    ["9371364b27a52acac9d87f88bd93c9db1174d8d6ec57f6888925cdc1788871ff", 65],
    ["de9fed2251b37295b763727a59ca35cf5cfe5c7379bc3e2104b2ce3c145aa887", 475],
  ]),
  contextLength: 16384,
  recommendedMemoryBytes: 16 * 1024 ** 3,
  minimumMemoryBytes: 8 * 1024 ** 3,
  diskReserveBytes: 1024 ** 3,
});

const SMALL_MODEL = Object.freeze({
  ...MODEL,
  id: "ollama/qwen3.5:2b",
  tag: "qwen3.5:2b",
  name: "Qwen 3.5 2B",
  licenseUrl: "https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE",
  sourceUrl: "https://ollama.com/library/qwen3.5:2b",
  digest: "324d162be6ca5629ae4517c8710434d0bd2d665bc94dbad46e9af8fbf8a2f0df",
  downloadBytes: 2741192820,
  layers: layers([
    ["b709d81508a078a686961de6ca07a953b895d9b286c46e17f00fb267f4f2d297", 2741180928],
    ["9be69ef463066202c1b1bd299aaf42bad370a01ba4b40d293617859720776c17", 11354],
    ["9371364b27a52acac9d87f88bd93c9db1174d8d6ec57f6888925cdc1788871ff", 65],
    ["ee043a99abe5e8317272712ed08ee2993af1f7930d69aefa3eba562cdc2822bd", 473],
  ]),
  contextLength: 8192,
  recommendedMemoryBytes: 8 * 1024 ** 3,
});
const MODELS = Object.freeze([SMALL_MODEL, MODEL]);
function chooseStarterModel() {
  // Use the evaluated 2B preset on every supported Mac. A saved approved
  // selection is restored by the manager without changing existing installs.
  return SMALL_MODEL;
}

module.exports = { MODEL, SMALL_MODEL, MODELS, chooseStarterModel, RUNTIME, OLLAMA_URL };
