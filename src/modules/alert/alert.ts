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
        description: 'Show an alert dialog; returns { button, index }.',
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
        inputSchema: {
          buttons: {
            default: [{ text: 'OK' }],
            description: 'Buttons — string or { text, style? }.',
            examples: [['OK'], ['Cancel', 'OK'], [{ style: 'destructive', text: 'Delete' }]],
            items: {
              oneOf: [
                { type: 'string' },
                {
                  properties: {
                    style: { enum: ['default', 'cancel', 'destructive'], type: 'string' },
                    text: { type: 'string' },
                  },
                  required: ['text'],
                  type: 'object',
                },
              ],
            },
            minItems: 1,
            type: 'array',
          },
          message: { default: '', description: 'Alert body.', type: 'string' },
          title: { default: 'Alert', description: 'Alert title.', type: 'string' },
        },
        timeout: ALERT_TIMEOUT,
      },
    },
  };
};
