import { type ProcessRunner } from './processRunner';
import { screenshotTool } from './tools/capture';
import { listDevicesTool } from './tools/devices';
import {
  dragTool,
  longPressTool,
  pressKeyTool,
  swipeTool,
  tapTool,
  typeTextBatchTool,
  typeTextTool,
} from './tools/input';
import { launchAppTool, restartAppTool, terminateAppTool } from './tools/lifecycle';
import { symbolicateTool } from './tools/symbolicate';
import { tapFiberTool } from './tools/tapFiber';
import { type HostModule } from './types';

export const hostModule = (runner: ProcessRunner): HostModule => {
  return {
    description: `OS-level device control executed on the MCP server host. Works even when the React Native app is hung, disconnected, or not yet installed.

BACKENDS
  iOS input (tap / swipe / type_text / press_key) goes through the bundled
  ios-hid binary — HID injection into iOS Simulator via SimulatorKit. No
  WebDriverAgent, no idb, no Appium server.
  Android input / screenshots go through adb (input / screencap / monkey
  / am force-stop).

COORDINATES
  All (x, y) / (x1, y1, x2, y2) are in PHYSICAL pixels, top-left origin.
  They match fiber_tree bounds.centerX/centerY — feed them directly.`,
    name: 'host',
    tools: {
      drag: dragTool(runner),
      launch_app: launchAppTool(runner),
      list_devices: listDevicesTool(runner),
      long_press: longPressTool(runner),
      press_key: pressKeyTool(runner),
      restart_app: restartAppTool(runner),
      screenshot: screenshotTool(runner),
      swipe: swipeTool(runner),
      symbolicate: symbolicateTool(),
      tap: tapTool(runner),
      tap_fiber: tapFiberTool(),
      terminate_app: terminateAppTool(runner),
      type_text: typeTextTool(runner),
      type_text_batch: typeTextBatchTool(runner),
    },
  };
};
