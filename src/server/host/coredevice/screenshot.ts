import { DtxConnection, buildDtxAux, dtxInt32 } from './dtx';
import { type NskaValue, decodeNska, encodeNska } from './nska';
import { fetchPeerInfo } from './rsd';
import { startTunnel } from './tunnel';

// Public entry point for taking a screenshot of a real iOS device via
// the CoreDevice tunnel.
//
// Flow:
//   1. `startTunnel` brings up the CoreDevice tunnel.
//   2. `fetchPeerInfo` enumerates services via RSD.
//   3. Open a DTX connection to `com.apple.instruments.dtservicehub`.
//   4. `_notifyOfPublishedCapabilities:` on channel 0 — DTX handshake.
//   5. `_requestChannelWithCode:identifier:` on channel 0 — binds our
//      chosen channel code to the screenshot service.
//   6. `takeScreenshot` on the new channel. The reply payload is an
//      NSKeyedArchive of an NSData holding the PNG bytes.

const DTSERVICEHUB_SERVICE = 'com.apple.instruments.dtservicehub';
const SCREENSHOT_SERVICE = 'com.apple.instruments.server.services.screenshot';
// Channel 0 is Apple's well-known control channel — `_notifyOfPublishedCapabilities:`
// and `_requestChannelWithCode:identifier:` land here. `1` is arbitrary; we
// pass it to `_requestChannelWithCode:` and Apple binds it to the screenshot
// service for the remainder of the connection.
const CONTROL_CHANNEL = 0;
const SCREENSHOT_CHANNEL = 1;

const DEFAULT_CAPABILITIES: NskaValue = {
  'com.apple.private.DTXBlockCompression': 0,
  'com.apple.private.DTXConnection': 1,
};

class CaptureScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureScreenshotError';
  }
}

interface CaptureScreenshotOptions {
  /**
   * Total wall-clock budget for the operation. Spent across three phases —
   * tunnel startup, RSD peer-info fetch, DTX dispatch — each given the
   * remaining budget at the time it runs. Default 30s.
   */
  timeoutMs?: number;
}

export const captureScreenshot = async (
  coreDeviceIdentifier: string,
  options: CaptureScreenshotOptions = {}
): Promise<Buffer> => {
  const totalBudgetMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + totalBudgetMs;
  const remaining = (): number => {
    return Math.max(1_000, deadline - Date.now());
  };

  const tunnel = await startTunnel(coreDeviceIdentifier, {
    startupTimeoutMs: remaining(),
  });
  try {
    const peer = await fetchPeerInfo(
      tunnel.info.deviceAddress,
      tunnel.info.hostAddress,
      tunnel.info.rsdPort,
      { timeoutMs: remaining() }
    );

    const hubEntry = peer.services[DTSERVICEHUB_SERVICE];
    if (!hubEntry) {
      throw new CaptureScreenshotError(`${DTSERVICEHUB_SERVICE} not in peer Services dict`);
    }

    const dtx = await DtxConnection.open(
      tunnel.info.deviceAddress,
      tunnel.info.hostAddress,
      hubEntry.port,
      { timeoutMs: remaining() }
    );

    try {
      let messageId = 0;
      const nextId = (): number => {
        messageId += 1;
        return messageId;
      };

      await dtx.invoke(
        CONTROL_CHANNEL,
        encodeNska('_notifyOfPublishedCapabilities:'),
        buildDtxAux([DEFAULT_CAPABILITIES]),
        { identifier: nextId(), wantsReply: false }
      );

      // Bind SCREENSHOT_CHANNEL → screenshot service. DtxConnection rejects
      // with DtxConnectionError on an Error reply, so we don't need a
      // separate branch here.
      await dtx.invoke(
        CONTROL_CHANNEL,
        encodeNska('_requestChannelWithCode:identifier:'),
        buildDtxAux([dtxInt32(SCREENSHOT_CHANNEL), SCREENSHOT_SERVICE]),
        { identifier: nextId(), timeoutMs: remaining() }
      );

      const reply = await dtx.invoke(
        SCREENSHOT_CHANNEL,
        encodeNska('takeScreenshot'),
        Buffer.alloc(0),
        { identifier: nextId(), timeoutMs: remaining() }
      );

      const decoded = decodeNska(reply.payload);
      if (!Buffer.isBuffer(decoded)) {
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
  } finally {
    await tunnel.close();
  }
};
