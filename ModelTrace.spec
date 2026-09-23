from pathlib import Path

project_dir = Path(SPECPATH)
analysis = Analysis(
    [str(project_dir / "start.py")],
    pathex=[str(project_dir)],
    binaries=[],
    datas=[
        (str(project_dir / "templates"), "templates"),
        (str(project_dir / "static"), "static"),
        (str(project_dir / "data"), "data"),
        (str(project_dir / "LICENSE"), "."),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="ModelTrace",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
