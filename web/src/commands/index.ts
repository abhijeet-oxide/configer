// The command barrel. Importing this module registers every feature's commands
// (each import runs the module's registerCommand calls for their side effect).
// Adding a feature's commands to the palette is exactly one line here.
import "./appCommands";

export { allCommands, getCommand, runCommand, registerCommand, type Command } from "./registry";
