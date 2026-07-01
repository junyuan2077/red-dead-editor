import os
from PIL import Image

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MARYBETH_DIR = os.path.join(BASE_DIR, "frontend", "assets", "marybeth")
ASSETS_DIR = os.path.join(BASE_DIR, "frontend", "assets")

def compress_png_to_webp(directory, filename, quality=80):
    src_path = os.path.join(directory, filename)
    dest_filename = os.path.splitext(filename)[0] + ".webp"
    dest_path = os.path.join(directory, dest_filename)
    
    print(f"Compressing {filename}...")
    try:
        with Image.open(src_path) as img:
            # Save as WebP with transparency
            img.save(dest_path, "WEBP", quality=quality)
        orig_size = os.path.getsize(src_path)
        new_size = os.path.getsize(dest_path)
        reduction = (orig_size - new_size) / orig_size * 100
        print(f"  Saved to {dest_filename}: {orig_size/1024:.1f}KB -> {new_size/1024:.1f}KB ({reduction:.1f}% reduction)")
    except Exception as e:
        print(f"  Error compressing {filename}: {e}")

def compress_app_icon():
    src_path = os.path.join(ASSETS_DIR, "marybeth_app_icon.png")
    if not os.path.exists(src_path):
        return
    print("Compressing app icon...")
    try:
        with Image.open(src_path) as img:
            # Resize app icon to standard 192x192 if it's huge
            if img.width > 192 or img.height > 192:
                img = img.resize((192, 192), Image.Resampling.LANCZOS)
            # Save back as optimized PNG or WebP
            # Let's save as optimized PNG to preserve standard compat, but make it tiny
            img.save(src_path, "PNG", optimize=True)
            print(f"  Optimized app icon saved: {os.path.getsize(src_path)/1024:.1f}KB")
    except Exception as e:
        print(f"  Error optimizing app icon: {e}")

if __name__ == "__main__":
    if os.path.isdir(MARYBETH_DIR):
        for f in os.listdir(MARYBETH_DIR):
            if f.endswith(".png") and not f.startswith("."):
                compress_png_to_webp(MARYBETH_DIR, f)
    compress_app_icon()
    print("Optimization complete.")
