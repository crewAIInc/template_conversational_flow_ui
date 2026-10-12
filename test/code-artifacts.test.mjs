import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeArtifacts, artifactFilename } from '../src/code-artifacts.mjs';

test('streaming code becomes a distinct artifact, while prose stays in chat', () => {
  assert.deepEqual(codeArtifacts('Here is an ordinary reply with `inline code`.'), []);
  const partial = codeArtifacts('Here is your class:\n```python\nclass Person:\n    pass');
  assert.deepEqual(partial, [{ line: 2, language: 'python', code: 'class Person:\n    pass', complete: false }]);
  const final = codeArtifacts('Here is your class:\n```python\nclass Person:\n    pass\n```\nYou can extend it later.');
  assert.equal(final[0].code, partial[0].code);
  assert.equal(final[0].complete, true);
  assert.equal(artifactFilename(final[0]), 'snippet.py');
  assert.deepEqual(codeArtifacts('~~~~js\nconst fence = "```";\n~~~\n~~~~\n\n  ```json\n  {}\n  ```').map(a => [a.language, a.code, a.complete]), [
    ['js', 'const fence = "```";\n~~~', true], ['json', '{}', true],
  ]);
  assert.equal(artifactFilename({ language: '../../secret' }), 'snippet.txt');
});
