export type AgentType =
  | "claude"
  | "goose"
  | "aider"
  | "codex"
  | "gemini"
  | "copilot"
  | "amp"
  | "cursor"
  | "auggie"
  | "amazonq"
  | "opencode"
  | "custom";

const WHITE_SPACE = /[\s\f\v]/;

export function screenDiff(oldScreen: string, newScreen: string, agentType: AgentType = "claude") {
  const oldLines = oldScreen.split("\n");
  const newLines = newScreen.split("\n");
  const oldLinesMap = new Set(oldLines);
  let dynamicHeaderEnd = -1;
  if (newLines.length >= 2 && agentType === "opencode") dynamicHeaderEnd = 2;
  let firstNonMatchingLine = newLines.length;
  const searchFrom = dynamicHeaderEnd + 1;
  for (let i = 0; i < newLines.length - searchFrom; i++) {
    const line = newLines[searchFrom + i];
    if (!oldLinesMap.has(line)) {
      firstNonMatchingLine = searchFrom + i;
      break;
    }
  }
  const newSectionLines = newLines.slice(firstNonMatchingLine);
  if (!newSectionLines.length) return "";
  let startLine = 0;
  let endLine = newSectionLines.length - 1;
  for (let i = 0; i < newSectionLines.length; i++) {
    if (newSectionLines[i].trim() !== "") {
      startLine = i;
      break;
    }
  }
  for (let i = newSectionLines.length - 1; i >= 0; i--) {
    if (newSectionLines[i].trim() !== "") {
      endLine = i;
      break;
    }
  }
  return newSectionLines.slice(startLine, endLine + 1).join("\n");
}

function normalizeAndGetRuneLineMapping(msgRaw: string): {
  runes: string[];
  lines: string[];
  runeLineLocations: number[];
} {
  const lines = msgRaw.split("\n");
  const runes: string[] = [];
  const runeLineLocations: number[] = [];
  lines.forEach((line, lineIdx) => {
    for (const r of line) {
      if (!WHITE_SPACE.test(r)) {
        runes.push(r);
        runeLineLocations.push(lineIdx);
      }
    }
  });
  return { runes, lines, runeLineLocations };
}

function indexSubslice(s: string[], sub: string[]) {
  if (!sub.length) return 0;
  if (sub.length > s.length) return -1;
  for (let i = 0; i <= s.length - sub.length; i++) {
    if (sub.every((ch, j) => s[i + j] === ch)) return i;
  }
  return -1;
}

function findUserInputStartIdx(
  msg: string[],
  msgRuneLineLocations: number[],
  userInput: string[],
  userInputLineLocations: number[],
) {
  let userInputPrefixLen = -1;
  for (let i = 0; i < userInputLineLocations.length; i++) {
    if (userInputLineLocations[i] > 0 || i >= 6) break;
    userInputPrefixLen = i + 1;
  }
  if (userInputPrefixLen === -1) return -1;
  let msgPrefixLen = 0;
  for (let i = 0; i < msgRuneLineLocations.length; i++) {
    if (msgRuneLineLocations[i] > 5) break;
    msgPrefixLen = i + 1;
  }
  if (msgPrefixLen < 25) msgPrefixLen = 25;
  if (msgPrefixLen > msg.length) msgPrefixLen = msg.length;
  return indexSubslice(msg.slice(0, msgPrefixLen), userInput.slice(0, userInputPrefixLen));
}

function findNextMatch(
  knownMsgMatchIdx: number,
  knownUserInputMatchIdx: number,
  msg: string[],
  userInput: string[],
) {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const userInputIdx = knownUserInputMatchIdx + i + 1;
      const msgIdx = knownMsgMatchIdx + j + 1;
      if (userInputIdx >= userInput.length || msgIdx >= msg.length) return [-1, -1] as const;
      if (userInput[userInputIdx] === msg[msgIdx]) return [msgIdx, userInputIdx] as const;
    }
  }
  return [-1, -1] as const;
}

function findUserInputEndIdx(userInputStartIdx: number, msg: string[], userInput: string[]) {
  let userInputIdx = 0;
  let msgIdx = userInputStartIdx;
  for (;;) {
    const [m, u] = findNextMatch(msgIdx, userInputIdx, msg, userInput);
    if (m === -1 || u === -1) break;
    msgIdx = m;
    userInputIdx = u;
  }
  return msgIdx;
}

function skipTrailingInputBoxLine(lines: string[], currentIdx: number, markers: string[]) {
  if (currentIdx + 1 >= lines.length) return { idx: currentIdx, found: false };
  const line = lines[currentIdx + 1];
  if (!markers.every((m) => line.includes(m))) return { idx: currentIdx, found: false };
  return { idx: currentIdx + 1, found: true };
}

export function removeUserInput(msgRaw: string, userInputRaw: string, agentType: AgentType) {
  if (!userInputRaw) return msgRaw;
  const msg = normalizeAndGetRuneLineMapping(msgRaw);
  const user = normalizeAndGetRuneLineMapping(userInputRaw);
  const start = findUserInputStartIdx(
    msg.runes,
    msg.runeLineLocations,
    user.runes,
    user.runeLineLocations,
  );
  if (start === -1) return msgRaw;
  const end = findUserInputEndIdx(start, msg.runes, user.runes);
  let lastUserInputLineIdx = msg.runeLineLocations[end];
  if (agentType === "gemini" || agentType === "copilot") {
    const skip = skipTrailingInputBoxLine(msg.lines, lastUserInputLineIdx, ["╯", "╰"]);
    if (skip.found) lastUserInputLineIdx = skip.idx;
  } else if (agentType === "cursor") {
    const skip = skipTrailingInputBoxLine(msg.lines, lastUserInputLineIdx, ["┘", "└"]);
    if (skip.found) lastUserInputLineIdx = skip.idx;
  } else if (agentType === "opencode" && lastUserInputLineIdx + 2 < msg.lines.length) {
    lastUserInputLineIdx += 2;
  }
  return msg.lines.slice(lastUserInputLineIdx + 1).join("\n");
}

function containsHorizontalBorder(line: string) {
  return (
    line.includes("───────────────") ||
    line.includes("╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌") ||
    line.includes("---------------") ||
    /-{6,}/.test(line)
  );
}

function findGreaterThanMessageBox(lines: string[]) {
  const start = Math.max(lines.length - 6, 0);
  for (let i = lines.length - 1; i >= start; i--) {
    if (lines[i].includes(">")) {
      if (i > 0 && containsHorizontalBorder(lines[i - 1])) return i - 1;
      return i;
    }
  }
  return -1;
}

function findGenericSlimMessageBox(lines: string[]) {
  const start = Math.max(lines.length - 9, 0);
  for (let i = lines.length - 3; i >= start; i--) {
    if (
      containsHorizontalBorder(lines[i]) &&
      (lines[i + 1].includes("|") || lines[i + 1].includes("│") || lines[i + 1].includes("❯")) &&
      containsHorizontalBorder(lines[i + 2])
    ) {
      return i;
    }
  }
  return -1;
}

function removeMessageBox(msg: string) {
  const lines = msg.split("\n");
  let messageBoxStartIdx = findGreaterThanMessageBox(lines);
  if (messageBoxStartIdx === -1) messageBoxStartIdx = findGenericSlimMessageBox(lines);
  if (messageBoxStartIdx !== -1) return lines.slice(0, messageBoxStartIdx).join("\n");
  return lines.join("\n");
}

function removeCodexMessageBox(msg: string) {
  const lines = msg.split("\n");
  if (lines.length >= 3 && lines[lines.length - 3].includes("›")) {
    const idx = lines.length - 3;
    return [...lines.slice(0, idx), lines[idx + 2]].join("\n");
  }
  return lines.join("\n");
}

function removeOpencodeMessageBox(msg: string) {
  const lines = msg.split("\n");
  for (let i = lines.length - 1; i >= 4; i--) {
    if (lines[i].trimStart().startsWith("╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀")) {
      return lines.slice(0, i - 4).join("\n");
    }
  }
  return lines.join("\n");
}

function removeAmpMessageBox(msg: string) {
  const lines = msg.split("\n");
  let msgBoxEndFound = false;
  let msgBoxStartIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!msgBoxEndFound && line.startsWith("╰") && line.endsWith("╯")) msgBoxEndFound = true;
    if (msgBoxEndFound && line.startsWith("╭") && line.endsWith("╮")) {
      msgBoxStartIdx = i;
      break;
    }
  }
  const formatted = lines.slice(0, msgBoxStartIdx).join("\n");
  return formatted.length === 0 ? "Welcome to Amp" : formatted;
}

function trimEmptyLines(message: string) {
  const lines = message.split("\n");
  let firstIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      firstIdx = i;
      break;
    }
    firstIdx = i + 1;
  }
  const kept = lines.slice(firstIdx);
  let lastIdx = kept.length - 1;
  for (let i = lastIdx; i >= 0; i--) {
    if (kept[i].trim() !== "") {
      lastIdx = i;
      break;
    }
  }
  return kept.slice(0, lastIdx + 1).join("\n");
}

export function formatAgentMessage(
  message: string,
  userInput: string,
  agentType: AgentType = "claude",
) {
  let next = removeUserInput(message, userInput, agentType);
  if (agentType === "codex") next = removeCodexMessageBox(next);
  else if (agentType === "opencode") next = removeOpencodeMessageBox(next);
  else if (agentType === "amp") next = removeAmpMessageBox(next);
  else next = removeMessageBox(next);
  return trimEmptyLines(next);
}
