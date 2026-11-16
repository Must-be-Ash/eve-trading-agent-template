import { disableTool } from "eve/tools";

// Eve 1.0 adds edit_file as a default tool; this agent keeps file writes disabled.
export default disableTool();
