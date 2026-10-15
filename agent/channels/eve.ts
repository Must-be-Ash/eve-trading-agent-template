import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";

// The local TUI is available for development. Production chat enters through Photon.
export default eveChannel({ auth: [localDev()] });
