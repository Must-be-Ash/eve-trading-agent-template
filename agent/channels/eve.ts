import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

// Production accepts same-project service calls, including approval cancellation.
// Coinbase still requires the independently authorized Photon user identity.
export default eveChannel({ auth: [vercelOidc(), localDev()] });
