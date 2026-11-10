from PyInstaller.utils.hooks import collect_all
from pathlib import Path

project = Path(SPECPATH).resolve().parent

required = [
    "numpy", "piper", "kokoro_onnx", "espeakng_loader", "onnxruntime", "torch",
    "transformers", "language_tags",
]
datas = []
binaries = []
hiddenimports = ["piper.download_voices"]
for package in required:
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

a = Analysis(
    [str(project / "tts" / "tts.py")],
    pathex=[str(project)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "pytest", "mlx", "mlx_audio", "misaki", "spacy",
        "spacy_curated_transformers", "en_core_web_sm",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    name="voxo-tts",
    exclude_binaries=True,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="voxo-tts",
)
