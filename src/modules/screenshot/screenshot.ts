import { type McpModule } from '@/client/models/types';

import { type ScreenshotModuleOptions } from './types';

const DEFAULT_QUALITY = 80;
const DEFAULT_MAX_WIDTH = 600;

const getSkia = () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const skia = require('@shopify/react-native-skia');
  const makeImageFromView = skia.makeImageFromView ?? skia.default?.makeImageFromView;
  const ImageFormat = skia.ImageFormat ?? skia.default?.ImageFormat;
  const Skia = skia.Skia ?? skia.default?.Skia;
  const FilterMode = skia.FilterMode ?? skia.default?.FilterMode;
  const MipmapMode = skia.MipmapMode ?? skia.default?.MipmapMode;

  if (typeof makeImageFromView !== 'function') {
    throw new Error(
      '@shopify/react-native-skia is required for the screenshot module. Install: yarn add @shopify/react-native-skia'
    );
  }

  return { FilterMode, ImageFormat, MipmapMode, Skia, makeImageFromView };
};

const resizeImage = (
  image: { height: () => number; width: () => number },
  targetWidth: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skia: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => {
  const scale = targetWidth / image.width();
  const newWidth = Math.round(image.width() * scale);
  const newHeight = Math.round(image.height() * scale);

  const surface = skia.Skia.Surface.Make(newWidth, newHeight);
  if (!surface) {
    return null;
  }

  const canvas = surface.getCanvas();
  const src = { height: image.height(), width: image.width(), x: 0, y: 0 };
  const dest = { height: newHeight, width: newWidth, x: 0, y: 0 };

  canvas.drawImageRectOptions(image, src, dest, skia.FilterMode.Linear, skia.MipmapMode.Linear);

  surface.flush();
  return surface.makeImageSnapshot();
};

export const screenshotModule = (options: ScreenshotModuleOptions): McpModule => {
  return {
    name: 'screenshot',
    tools: {
      capture: {
        description:
          'Capture a screenshot of the app. Returns a JPEG image resized to maxWidth. Use format "png" for lossless.',
        handler: async (args) => {
          const skia = getSkia();
          const format = (args.format as string) === 'png' ? 'png' : 'jpeg';
          const quality = (args.quality as number) ?? DEFAULT_QUALITY;
          const maxWidth = (args.maxWidth as number) ?? DEFAULT_MAX_WIDTH;
          const imageFormat = format === 'png' ? skia.ImageFormat.PNG : skia.ImageFormat.JPEG;
          const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

          const snapshot = await skia.makeImageFromView(options.rootRef);
          if (!snapshot) {
            throw new Error(
              'Failed to capture screenshot. Make sure rootRef is attached to a View with collapsable={false}.'
            );
          }

          let finalImage = snapshot;

          if (snapshot.width() > maxWidth) {
            const resized = resizeImage(snapshot, maxWidth, skia);
            if (resized) {
              snapshot.dispose();
              finalImage = resized;
            }
          }

          const base64 = finalImage.encodeToBase64(imageFormat, quality);
          finalImage.dispose();

          return [{ data: base64, mimeType, type: 'image' }];
        },
        inputSchema: {
          format: {
            description: 'Image format: "jpeg" (smaller, default) or "png" (lossless)',
            enum: ['jpeg', 'png'],
            type: 'string',
          },
          maxWidth: {
            description: `Max width in pixels (default: ${DEFAULT_MAX_WIDTH}). Height scales proportionally.`,
            type: 'number',
          },
          quality: {
            description: 'Image quality 0-100 (default: 80, for jpeg)',
            type: 'number',
          },
        },
        timeout: 10_000,
      },
    },
  };
};
