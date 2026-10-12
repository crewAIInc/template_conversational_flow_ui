// Read top-level Markdown fences, including an unfinished fence during streaming.
export function codeArtifacts(text = '') {
  const artifacts = [];
  const lines = text.split(/\r?\n/);
  let current;
  lines.forEach((line, index) => {
    if (!current) {
      const opening = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
      if (!opening || (opening[2][0] === '`' && opening[3].includes('`'))) return;
      current = { line: index + 1, language: opening[3].trim().split(/\s+/)[0].toLowerCase(), fence: opening[2], indent: opening[1].length, lines: [] };
    } else {
      const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === current.fence[0] && closing[1].length >= current.fence.length) {
        artifacts.push({ line: current.line, language: current.language, code: current.lines.join('\n'), complete: true });
        current = undefined;
      } else current.lines.push(line.replace(new RegExp(`^ {0,${current.indent}}`), ''));
    }
  });
  if (current) artifacts.push({ line: current.line, language: current.language, code: current.lines.join('\n'), complete: false });
  return artifacts;
}

export function artifactFilename(artifact) {
  const extensions = { python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', bash: 'sh', sql: 'sql' };
  return `snippet.${Object.hasOwn(extensions, artifact.language) ? extensions[artifact.language] : 'txt'}`;
}
