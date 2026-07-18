import { z } from 'zod';

import { resolveDevice } from '@/server/host/deviceResolver';
import { NATIVE_ID_SCHEMA, parseResolveOptions, PLATFORM_ARG_SCHEMA } from '@/server/host/helpers';
import { typeTextIos } from '@/server/host/iosInput';
import { type ProcessRunner } from '@/server/host/processRunner';
import { type HostToolHandler } from '@/server/host/types';

import { typeTextAndroid } from './android';
import { INPUT_TIMEOUT_MS } from './constants';

export const typeTextTool = (runner: ProcessRunner): HostToolHandler => {
  return {
    description:
      "Primary way to type into the currently focused text input — replaces existing content (select-all then paste). submit:true presses ENTER after typing. iOS: unicode via clipboard paste, keyboard-layout immune. Android: ASCII only (adb input text limitation); for non-Latin scripts fall back to fiber_tree__call on the input's onChangeText.",
    handler: async (args, ctx) => {
      const resolved = await resolveDevice(ctx, parseResolveOptions(args), runner);
      if (!resolved.ok) {
        return { error: resolved.error };
      }
      const text = typeof args.text === 'string' ? args.text : undefined;
      if (text === undefined) {
        return { error: "'text' is required and must be a string" };
      }
      const submit = args.submit === true;
      const result =
        resolved.device.platform === 'ios'
          ? await typeTextIos(resolved.device.nativeId, text, submit, runner)
          : await typeTextAndroid(resolved.device.nativeId, text, submit, runner);
      if ('error' in result) {
        return { error: result.error };
      }
      return {
        device: resolved.device,
        length: text.length,
        submitted: submit,
        typed: true,
      };
    },
    inputSchema: z.looseObject({
      platform: PLATFORM_ARG_SCHEMA,
      submit: z
        .boolean()
        .describe('Press ENTER after typing (e.g. to submit a search).')
        .meta({ default: false })
        .optional(),
      text: z
        .string()
        .describe(
          'Text to type into the currently focused input field. Whitespace and shell metacharacters are escaped automatically.'
        ),
      ...NATIVE_ID_SCHEMA,
    }),
    timeout: INPUT_TIMEOUT_MS,
  };
};
