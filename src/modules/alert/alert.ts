import { z } from 'zod';

import { type McpModule } from '@/client/models/types';
import { getRN } from '@/shared/rn/core';

const ALERT_TIMEOUT = 60_000;

type ButtonStyle = 'cancel' | 'default' | 'destructive';

interface AlertButton {
  text: string;
  style?: ButtonStyle;
}

export const alertModule = (): McpModule => {
  return {
    description: 'Show native Alert.alert dialogs and get back which button was pressed.',
    name: 'alert',
    tools: {
      show: {
        description:
          'Show a native alert; resolves { button: <text>, index: <0-based position in buttons> } when a button is tapped (waits up to 60s).',
        handler: (args) => {
          const { Alert } = getRN();
          const rawButtons = args.buttons as Array<string | AlertButton> | undefined;
          const buttons: AlertButton[] = rawButtons
            ? rawButtons.map((b) => {
                return typeof b === 'string' ? { text: b } : b;
              })
            : [{ text: 'OK' }];

          return new Promise((resolve) => {
            Alert.alert(
              (args.title as string) || 'Alert',
              (args.message as string) || '',
              buttons.map((btn, index) => {
                return {
                  onPress: () => {
                    resolve({ button: btn.text, index });
                  },
                  style: btn.style ?? 'default',
                  text: btn.text,
                };
              })
            );
          });
        },
        inputSchema: z.looseObject({
          buttons: z
            .array(
              z.union([
                z.string(),
                z.looseObject({
                  style: z.enum(['default', 'cancel', 'destructive']).optional(),
                  text: z.string(),
                }),
              ])
            )
            .min(1)
            .describe('A bare string is shorthand for { text }.')
            .meta({
              default: [{ text: 'OK' }],
              examples: [['OK'], ['Cancel', 'OK'], [{ style: 'destructive', text: 'Delete' }]],
            })
            .optional(),
          message: z.string().describe('Alert body.').meta({ default: '' }).optional(),
          title: z.string().describe('Alert title.').meta({ default: 'Alert' }).optional(),
        }),
        timeout: ALERT_TIMEOUT,
      },
    },
  };
};
