import { lines } from './text.js';

/** A React function component: `body` is the JSX it returns (one element per line, already indented by 4). */
export function componentFile(params: { name: string; props: string[]; body: string[]; imports?: string[]; style?: 'function' | 'arrow' }): string {
  const { name, props, body, imports = [], style = 'function' } = params;
  const propsType = `${name}Props`;
  const parameter = props.length === 0 ? '' : `{ ${props.map(prop => prop.split(':')[0]?.replace('?', '').trim()).join(', ')} }: ${propsType}`;
  const header = [
    ...imports,
    ...(imports.length === 0 ? [] : ['']),
    ...(props.length === 0 ? [] : [`export interface ${propsType} {`, ...props.map(prop => `  ${prop};`), '}', '']),
  ];
  if (style === 'arrow') return lines(header, `export const ${name} = (${parameter}) => (`, body.map(line => line.slice(2)), ');');
  return lines(header, `export function ${name}(${parameter}) {`, '  return (', body, '  );', '}');
}

/** A Storybook story file for `name` (not a component itself). */
export function storyFile(params: { name: string; module: string; args: string }): string {
  const { name, module, args } = params;
  return lines(
    `import { ${name} } from './${module}';`,
    '',
    `export default { title: 'ui/${name}', component: ${name} };`,
    '',
    `export const Primary = () => <${name} ${args} />;`,
  );
}

/** A component test rendering `name`. */
export function componentTest(params: { name: string; module: string; args: string }): string {
  const { name, module, args } = params;
  return lines(
    "import { render } from '@testing-library/react';",
    "import { expect, it } from 'vitest';",
    `import { ${name} } from './${module}';`,
    '',
    `it('renders ${name}', () => {`,
    `  const { container } = render(<${name} ${args} />);`,
    '  expect(container.firstChild).not.toBeNull();',
    '});',
  );
}
