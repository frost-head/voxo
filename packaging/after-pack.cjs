const fs = require('node:fs');
const path = require('node:path');

module.exports = async function ensureWindowsSpeechRuntime(context) {
  if (context.electronPlatformName !== 'win32') return;

  const projectDir = context.packager.projectDir;
  const sourceDir = path.join(projectDir, 'build', 'tts', 'voxo-tts');
  const executableName = 'voxo-tts.exe';
  const sourceExecutable = path.join(sourceDir, executableName);
  if (!fs.existsSync(sourceExecutable)) {
    throw new Error(
      `Windows speech runtime was not built at ${sourceExecutable}. Run "npm run build:tts" before packaging.`,
    );
  }
  const magic = Buffer.alloc(2);
  const fd = fs.openSync(sourceExecutable, 'r');
  try {
    fs.readSync(fd, magic, 0, magic.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (magic.toString('ascii') !== 'MZ') {
    throw new Error(`${sourceExecutable} is not a Windows executable (expected an MZ/PE file). Build it on Windows.`);
  }
  if (!fs.existsSync(path.join(sourceDir, '_internal'))) {
    throw new Error(`PyInstaller runtime folder is missing from ${sourceDir}. Rebuild it with the current voxo-tts.spec.`);
  }

  // PyInstaller's one-folder build includes _internal alongside the .exe.
  // Copy the whole directory so its Python runtime and native libraries ship too.
  const destinationDir = path.join(context.appOutDir, 'resources', 'tts', 'voxo-tts');
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });

  if (!fs.existsSync(path.join(destinationDir, executableName))) {
    throw new Error(`Packaged Windows speech runtime is missing from ${destinationDir}.`);
  }
  if (!fs.existsSync(path.join(destinationDir, '_internal'))) {
    throw new Error(`Packaged Windows PyInstaller runtime is missing from ${destinationDir}.`);
  }
};
