import sharp from 'sharp';

/**
 * Reads an image from the filesystem, resizes it to a lower resolution,
 * and returns it as a base64 string suitable for LLM vision models.
 * @param filePath - The path to the image file
 * @param maxDimension - The maximum width or height of the image (default 512)
 * @returns The resized image as a base64 string (JPEG format)
 */
export async function getLowResBase64Image(filePath: string, maxDimension: number = 512): Promise<string> {
    try {
        const imageBuffer = await sharp(filePath)
            .resize({
                width: maxDimension,
                height: maxDimension,
                fit: 'inside',       // Preserves aspect ratio, ensuring neither dimension exceeds maxDimension
                withoutEnlargement: true // Doesn't upscale if the image is already smaller
            })
            .jpeg({ quality: 80 })   // Convert to JPEG with decent compression
            .toBuffer();

        return imageBuffer.toString('base64');
    } catch (error) {
        console.error(`Failed to process image ${filePath}:`, error);
        throw error;
    }
}
