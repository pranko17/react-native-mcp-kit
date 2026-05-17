import { DtxConnection, DtxMessageType, buildDtxAux, dtxInt32 } from './dtx';
import { type NskaValue, decodeNska, encodeNska } from './nska';
import { fetchPeerInfo } from './rsd';
import { type TunnelInfo, startTunnel } from './tunnel';

// Layer 6 of the real-device screenshot stack — talks DTX to
// `com.apple.instruments.dtservicehub` and asks the
// `com.apple.instruments.server.services.screenshot` channel for a PNG.
//
// The dance:
//
//  1. RSD enumerate (rsd.ts) — find the dtservicehub port.
//  2. TCP-connect to dtservicehub from the Mac end of the tunnel.
//  3. Send `_notifyOfPublishedCapabilities:` on channel 0 with the
//     capability dict {DTXBlockCompression:0, DTXConnection:1}.
//     This is the DTX handshake; the peer replies in kind.
//  4. Send `_requestChannelWithCode:identifier:` on channel 0 with
//     args [channel_code, "com.apple.instruments.server.services.screenshot"].
//     The reply confirms our chosen channel code is now bound to the
//     screenshot service.
//  5. Send `takeScreenshot` on the new channel. Reply payload is an
//     NSKeyedArchive holding an NSData with the PNG bytes.
//
// All wire formats are documented in PROTOCOL.md.

const DTSERVICEHUB_SERVICE = 'com.apple.instruments.dtservicehub';
const SCREENSHOT_SERVICE = 'com.apple.instruments.server.services.screenshot';
const CONTROL_CHANNEL = 0;
const SCREENSHOT_CHANNEL = 1;

const DEFAULT_CAPABILITIES: NskaValue = {
  'com.apple.private.DTXBlockCompression': 0,
  'com.apple.private.DTXConnection': 1,
};

export class CaptureScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureScreenshotError';
  }
}

export interface CaptureScreenshotOptions {
  /** Total budget for the operation. Default 30s. */
  timeoutMs?: number;
}

// Top-level: bring up a fresh tunnel, do the whole stack, close.
export const captureScreenshot = async (
  coreDeviceIdentifier: string,
  options: CaptureScreenshotOptions = {}
): Promise<Buffer> => {
  const tunnel = await startTunnel(coreDeviceIdentifier, {
    startupTimeoutMs: options.timeoutMs,
  });
  try {
    return await captureScreenshotWithTunnel(tunnel.info, options);
  } finally {
    await tunnel.close();
  }
};

// Same as above but reuses an already-up tunnel. Useful when the caller
// is going to take multiple screenshots and wants to amortise the
// 5-second tunnel-up cost.
export const captureScreenshotWithTunnel = async (
  tunnel: TunnelInfo,
  options: CaptureScreenshotOptions = {}
): Promise<Buffer> => {
  const peer = await fetchPeerInfo(tunnel.deviceAddress, tunnel.hostAddress, tunnel.rsdPort, {
    timeoutMs: options.timeoutMs,
  });

  const hubEntry = peer.services[DTSERVICEHUB_SERVICE];
  if (!hubEntry) {
    throw new CaptureScreenshotError(`${DTSERVICEHUB_SERVICE} not in peer Services dict`);
  }

  const dtx = await DtxConnection.open(tunnel.deviceAddress, tunnel.hostAddress, hubEntry.port, {
    timeoutMs: options.timeoutMs,
  });

  try {
    let messageId = 0;
    const nextId = (): number => {
      messageId += 1;
      return messageId;
    };

    // Handshake: announce our capabilities to the peer.
    await dtx.invoke(
      CONTROL_CHANNEL,
      encodeNska('_notifyOfPublishedCapabilities:'),
      buildDtxAux([DEFAULT_CAPABILITIES]),
      { identifier: nextId(), wantsReply: false }
    );

    // Open the screenshot service on a private channel code. The reply
    // (which we wait for) confirms the bind.
    const channelReply = await dtx.invoke(
      CONTROL_CHANNEL,
      encodeNska('_requestChannelWithCode:identifier:'),
      buildDtxAux([dtxInt32(SCREENSHOT_CHANNEL), SCREENSHOT_SERVICE]),
      { identifier: nextId() }
    );
    if (channelReply && channelReply.msgType === DtxMessageType.Error) {
      throw new CaptureScreenshotError(
        `Channel open for ${SCREENSHOT_SERVICE} failed (msgType=${channelReply.msgType})`
      );
    }

    // Take the screenshot.
    const reply = await dtx.invoke(
      SCREENSHOT_CHANNEL,
      encodeNska('takeScreenshot'),
      Buffer.alloc(0),
      { identifier: nextId() }
    );
    if (!reply) {
      throw new CaptureScreenshotError('takeScreenshot returned no reply');
    }
    if (reply.msgType === DtxMessageType.Error) {
      throw new CaptureScreenshotError('takeScreenshot returned an Error message');
    }

    const decoded = decodeNska(reply.payload);
    if (!Buffer.isBuffer(decoded)) {
      // Sometimes the reply is wrapped in a different shape — surface
      // enough detail to debug without leaking the whole graph.
      const desc =
        decoded && typeof decoded === 'object' && !Array.isArray(decoded)
          ? `object with keys [${Object.keys(decoded).join(', ')}]`
          : typeof decoded;
      throw new CaptureScreenshotError(`takeScreenshot reply was ${desc}, expected NSData`);
    }
    return decoded;
  } finally {
    dtx.close();
  }
};
