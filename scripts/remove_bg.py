import sys
from PIL import Image

def remove_background(image_path, output_path, tolerance=30):
    # Load image and convert to RGBA
    img = Image.open(image_path).convert("RGBA")
    width, height = img.size
    
    # Get the background color at (0, 0)
    bg_color = img.getpixel((0, 0))
    print(f"Background color detected at (0, 0): {bg_color}")
    
    # Collect seed points along the edges
    seeds = []
    # Check top and bottom edges
    for x in range(width):
        seeds.append((x, 0))
        seeds.append((x, height - 1))
    # Check left and right edges
    for y in range(height):
        seeds.append((0, y))
        seeds.append((width - 1, y))
        
    def color_dist(c1, c2):
        return sum((a - b) ** 2 for a, b in zip(c1[:3], c2[:3])) ** 0.5

    # Keep track of visited pixels to avoid redundant floodfills
    visited = set()
    pixels = img.load()
    
    # BFS floodfill
    for seed in seeds:
        sx, sy = seed
        if (sx, sy) in visited:
            continue
        
        scolor = pixels[sx, sy]
        if color_dist(scolor, bg_color) > tolerance:
            continue
            
        queue = [(sx, sy)]
        visited.add((sx, sy))
        
        while queue:
            cx, cy = queue.pop(0)
            pixels[cx, cy] = (0, 0, 0, 0)
            
            # Check 4-neighbors
            for nx, ny in [(cx-1, cy), (cx+1, cy), (cx, cy-1), (cx, cy+1)]:
                if 0 <= nx < width and 0 <= ny < height:
                    if (nx, ny) not in visited:
                        ncolor = pixels[nx, ny]
                        if color_dist(ncolor, bg_color) <= tolerance:
                            visited.add((nx, ny))
                            queue.append((nx, ny))
                            
    img.save(output_path, "PNG")
    print(f"Saved transparent image to {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python remove_bg.py <input_path> <output_path> [tolerance]")
        sys.exit(1)
    
    input_p = sys.argv[1]
    output_p = sys.argv[2]
    tol = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    remove_background(input_p, output_p, tol)
