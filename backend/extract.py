#!/usr/bin/env python3
"""
extract.py — UnityPy-based Unity asset extractor
Called by extractor.js via child_process.exec

Usage:
    python3 extract.py <apk_path> <output_dir> <manifest_path>

Outputs:
    - Extracted asset files into <output_dir>/
    - JSON manifest written to <manifest_path>
"""

import sys
import os
import json
import traceback

try:
    import UnityPy
    from UnityPy.classes import (
        Texture2D, Sprite, AudioClip, Mesh,
        TextAsset, MonoBehaviour, Font, Shader,
        GameObject, AnimationClip, Material
    )
except ImportError:
    print(json.dumps({ "error": "UnityPy not installed. Run: pip3 install UnityPy" }))
    sys.exit(1)

# ── TYPE MAP ──────────────────────────────────────────────────────────────────
TYPE_META = {
    "Texture2D":      { "type": "texture",  "emoji": "🖼",  "ext": "png"  },
    "Sprite":         { "type": "texture",  "emoji": "🖼",  "ext": "png"  },
    "AudioClip":      { "type": "audio",    "emoji": "🔊",  "ext": "wav"  },
    "Mesh":           { "type": "mesh",     "emoji": "🧊",  "ext": "obj"  },
    "TextAsset":      { "type": "text",     "emoji": "📄",  "ext": "txt"  },
    "MonoBehaviour":  { "type": "script",   "emoji": "📜",  "ext": "json" },
    "Font":           { "type": "font",     "emoji": "🔤",  "ext": "ttf"  },
    "Shader":         { "type": "shader",   "emoji": "✨",  "ext": "txt"  },
    "Material":       { "type": "material", "emoji": "🎨",  "ext": "mat"  },
    "AnimationClip":  { "type": "anim",     "emoji": "🎬",  "ext": "anim" },
    "GameObject":     { "type": "prefab",   "emoji": "🧩",  "ext": "json" },
}

def safe_name(name):
    """Sanitize asset names for filesystem use."""
    if not name:
        return "unnamed"
    return "".join(c if c.isalnum() or c in "._- " else "_" for c in name).strip()

def extract_apk(apk_path, out_dir):
    assets = []
    seen_names = {}

    os.makedirs(out_dir, exist_ok=True)

    print(f"[UnityPy] Loading: {apk_path}", flush=True)
    env = UnityPy.load(apk_path)
    print(f"[UnityPy] Loaded. Iterating objects...", flush=True)

    for obj in env.objects:
        type_name = obj.type.name
        meta = TYPE_META.get(type_name)
        if not meta:
            continue

        try:
            data = obj.parse_as_object()
            name = safe_name(getattr(data, "m_Name", None) or type_name)

            # Deduplicate names
            if name in seen_names:
                seen_names[name] += 1
                name = f"{name}_{seen_names[name]}"
            else:
                seen_names[name] = 0

            ext      = meta["ext"]
            rel_path = os.path.join(meta["type"], f"{name}.{ext}")
            abs_path = os.path.join(out_dir, rel_path)
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)

            wrote = False

            # ── Textures & Sprites ──────────────────────────────────────────
            if type_name in ("Texture2D", "Sprite"):
                try:
                    img = data.image
                    if img:
                        img.save(abs_path)
                        wrote = True
                except Exception:
                    pass

            # ── Audio ───────────────────────────────────────────────────────
            elif type_name == "AudioClip":
                try:
                    for clip_name, clip_data in data.samples.items():
                        if clip_data:
                            with open(abs_path, "wb") as f:
                                f.write(clip_data)
                            wrote = True
                            break
                except Exception:
                    pass

            # ── Text Assets ─────────────────────────────────────────────────
            elif type_name == "TextAsset":
                try:
                    script = data.m_Script
                    if script:
                        content = script if isinstance(script, bytes) else script.encode("utf-8", errors="replace")
                        with open(abs_path, "wb") as f:
                            f.write(content)
                        wrote = True
                except Exception:
                    pass

            # ── MonoBehaviour / GameObject — export as JSON typetree ────────
            elif type_name in ("MonoBehaviour", "GameObject"):
                try:
                    d = obj.parse_as_dict()
                    with open(abs_path, "w", encoding="utf-8") as f:
                        json.dump(d, f, indent=2, ensure_ascii=False, default=str)
                    wrote = True
                except Exception:
                    pass

            # ── Mesh — export as OBJ ────────────────────────────────────────
            elif type_name == "Mesh":
                try:
                    # Basic OBJ export from vertex data
                    mesh_data = obj.parse_as_dict()
                    with open(abs_path, "w") as f:
                        f.write(f"# Exported by UnityRip\n# Mesh: {name}\n")
                        verts = mesh_data.get("m_Vertices", [])
                        for i in range(0, len(verts), 3):
                            f.write(f"v {verts[i]} {verts[i+1]} {verts[i+2]}\n")
                        indices = mesh_data.get("m_IndexBuffer", [])
                        for i in range(0, len(indices), 3):
                            f.write(f"f {indices[i]+1} {indices[i+1]+1} {indices[i+2]+1}\n")
                    wrote = True
                except Exception:
                    pass

            # ── Everything else — dump typetree as JSON ─────────────────────
            else:
                try:
                    d = obj.parse_as_dict()
                    with open(abs_path, "w", encoding="utf-8") as f:
                        json.dump(d, f, indent=2, ensure_ascii=False, default=str)
                    wrote = True
                except Exception:
                    pass

            if wrote:
                size = os.path.getsize(abs_path)
                assets.append({
                    "name":         name,
                    "filename":     f"{name}.{ext}",
                    "ext":          ext,
                    "type":         meta["type"],
                    "emoji":        meta["emoji"],
                    "unityType":    type_name,
                    "relativePath": rel_path,
                    "sizeBytes":    size,
                    "size":         fmt_bytes(size),
                    "bundle":       getattr(obj.assets_file, "name", "unknown"),
                })

        except Exception as e:
            # Don't let one bad asset kill the whole run
            continue

    return assets

def fmt_bytes(b):
    if b < 1024: return f"{b} B"
    if b < 1024**2: return f"{b/1024:.1f} KB"
    return f"{b/1024**2:.1f} MB"

def build_stats(assets):
    by_type = {}
    total = 0
    for a in assets:
        by_type[a["type"]] = by_type.get(a["type"], 0) + 1
        total += a["sizeBytes"]
    bundles = len(set(a["bundle"] for a in assets))
    return {
        "total":       len(assets),
        "byType":      by_type,
        "totalSize":   fmt_bytes(total),
        "bundleCount": bundles,
    }

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: extract.py <apk_path> <out_dir> <manifest_path>")
        sys.exit(1)

    apk_path      = sys.argv[1]
    out_dir       = sys.argv[2]
    manifest_path = sys.argv[3]

    try:
        assets = extract_apk(apk_path, out_dir)
        stats  = build_stats(assets)
        result = { "ok": True, "assets": assets, "stats": stats }
    except Exception as e:
        result = { "ok": False, "error": str(e), "trace": traceback.format_exc() }

    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, "w") as f:
        json.dump(result, f)

    print(f"[UnityPy] Done. {len(result.get('assets', []))} assets extracted.", flush=True)
    sys.exit(0 if result["ok"] else 1)
