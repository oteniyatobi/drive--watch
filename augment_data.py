import os
import sys

print("Checking requirements...")
try:
    from PIL import Image, ImageEnhance, ImageOps
except ImportError:
    print("Installing required library 'Pillow'...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
    from PIL import Image, ImageEnhance, ImageOps

def augment_images(input_folder, output_folder):
    """
    Takes all images in input_folder and creates 4 new versions of each:
    1. Flipped horizontally (simulates sitting on the other side of the car/room)
    2. Brighter (simulates daytime)
    3. Darker (simulates nighttime/evening)
    4. Slightly rotated (simulates tilting head differently)
    """
    
    if not os.path.exists(input_folder):
        print(f"Error: Folder '{input_folder}' not found.")
        print(f"Please create a folder named '{input_folder}' and put your original images inside it.")
        return

    # Create output folder if it doesn't exist
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)

    valid_extensions = {".jpg", ".jpeg", ".png", ".webp"}
    images = [f for f in os.listdir(input_folder) if os.path.splitext(f)[1].lower() in valid_extensions]
    
    if not images:
        print(f"No original images found in '{input_folder}'. Add some photos first!")
        return
        
    print(f"Found {len(images)} original images. Generating augmented dataset...")
    
    generated_count = 0
    
    for filename in images:
        input_path = os.path.join(input_folder, filename)
        name, ext = os.path.splitext(filename)
        
        try:
            with Image.open(input_path) as img:
                # Convert to RGB if needed
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                
                # Copy original to output
                img.save(os.path.join(output_folder, f"{name}_orig{ext}"))
                generated_count += 1
                
                # 1. Flip horizontally
                flipped = ImageOps.mirror(img)
                flipped.save(os.path.join(output_folder, f"{name}_flip{ext}"))
                generated_count += 1
                
                # 2. Brightness Increase
                enhancer = ImageEnhance.Brightness(img)
                brighter = enhancer.enhance(1.4) 
                brighter.save(os.path.join(output_folder, f"{name}_bright{ext}"))
                generated_count += 1
                
                # 3. Brightness Decrease
                darker = enhancer.enhance(0.6) 
                darker.save(os.path.join(output_folder, f"{name}_dark{ext}"))
                generated_count += 1
                
                # 4. Rotation (tilt)
                rotated1 = img.rotate(10, expand=False, fillcolor="black")
                rotated1.save(os.path.join(output_folder, f"{name}_rot10{ext}"))
                generated_count += 1
                
                # 5. Grayscale (Focus on features/eyes)
                gray = ImageOps.grayscale(img)
                gray.save(os.path.join(output_folder, f"{name}_gray{ext}"))
                generated_count += 1

                # 6. High Contrast (Simulate direct sun)
                con_enhancer = ImageEnhance.Contrast(img)
                high_con = con_enhancer.enhance(1.8)
                high_con.save(os.path.join(output_folder, f"{name}_contrast{ext}"))
                generated_count += 1

                # 7. Add Noise (Simulate low-light grain)
                # We'll do a simple pixel-level noise
                import random
                pixels = img.load()
                for i in range(img.size[0]):
                    for j in range(img.size[1]):
                        if random.random() < 0.05: # 5% noise
                            noise = random.randint(-30, 30)
                            r, g, b = pixels[i, j]
                            pixels[i, j] = (
                                max(0, min(255, r + noise)),
                                max(0, min(255, g + noise)),
                                max(0, min(255, b + noise))
                            )
                img.save(os.path.join(output_folder, f"{name}_noisy{ext}"))
                generated_count += 1
                
        except Exception as e:
            print(f"Error processing {filename}: {e}")
            
    print("-" * 40)
    print(f"SUCCESS! You now have {generated_count} images in the '{output_folder}' folder.")
    print(f"You can upload these to Teachable Machine (it's {generated_count // len(images)}x more data!)")

if __name__ == "__main__":
    print("-" * 40)
    print("DRIVER WATCH - TRAINING DATA AUGMENTER")
    print("-" * 40)
    
    print("\nProcessing AWAKE images...")
    augment_images("training_data/original_awake", "training_data/boosted_awake")
    
    print("\nProcessing SLEEPY images...")
    augment_images("training_data/original_sleepy", "training_data/boosted_sleepy")
    
    print("\nProcessing NEUTRAL images...")
    augment_images("training_data/original_neutral", "training_data/boosted_neutral")
    
    print("\nDone! Upload the 'boosted' folders into Teachable Machine.")
