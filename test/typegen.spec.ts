import path from 'path';
import { fileURLToPath } from 'url';

import { expect } from 'chai';
import sinon from 'sinon';

import { createRouteRegistry } from '../src/defineRoute.ts';
import {
  applyGeneratedResponseSchemas,
  fileLooksLikeItUsesWithResponses,
} from '../src/typegen/applyGeneratedResponseSchemas.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSCONFIG_PATH = path.join(__dirname, '..', 'tsconfig.json');
const FIXTURES_DIR = path.join(__dirname, 'typegenFixtures');
const CJS_STYLE_DIR = path.join(FIXTURES_DIR, 'cjsStyle');
const CJS_STYLE_TSCONFIG_PATH = path.join(CJS_STYLE_DIR, 'tsconfig.json');

function fixture(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

describe('UNIT: applyGeneratedResponseSchemas', () => {
  it('fills in $ref/array/toJSON-derived response schemas and components.schemas', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    // Seed the paths buildOpenApiDocument would produce for the fixture's
    // routes, so this tests applyGeneratedResponseSchemas alone.
    doc.paths['/widgets/{id}'] = {
      get: {
        summary: 'Get a widget',
        responses: { 200: { description: 'The widget' } },
      },
    };
    doc.paths['/widgets/extra'] = {
      get: {
        summary: 'List widgets',
        responses: { 200: { description: 'The widgets' } },
      },
    };
    doc.paths['/widgets/serializable'] = {
      get: {
        summary: 'Get a serializable thing',
        responses: { 200: { description: 'The thing' } },
      },
    };

    applyGeneratedResponseSchemas(
      doc,
      [fixture('basicRouter.ts')],
      TSCONFIG_PATH
    );

    const widgetSchema =
      doc.paths['/widgets/{id}'].get?.responses?.['200'].content[
        'application/json'
      ].schema;
    expect(widgetSchema).to.eql({ $ref: '#/components/schemas/Widget' });
    expect(doc.components.schemas?.Widget).to.eql({
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
      additionalProperties: false,
    });

    const widgetsSchema =
      doc.paths['/widgets/extra'].get?.responses?.['200'].content[
        'application/json'
      ].schema;
    expect(widgetsSchema).to.eql({
      type: 'array',
      items: { $ref: '#/components/schemas/Widget' },
    });

    const serializableSchema =
      doc.paths['/widgets/serializable'].get?.responses?.['200'].content[
        'application/json'
      ].schema;
    expect(serializableSchema).to.eql({
      $ref: '#/components/schemas/SerializableThing',
    });
    // toJSON's return type, not the class's shape.
    expect(doc.components.schemas?.SerializableThing).to.eql({
      type: 'object',
      properties: { code: { type: 'string' }, msg: { type: 'string' } },
      required: ['code', 'msg'],
      additionalProperties: false,
    });
  });

  it('resolves a path built from an imported `as const` constant', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    doc.paths['/gadgets/{gadget_id}'] = {
      get: {
        summary: 'Get a gadget',
        responses: { 200: { description: 'The gadget' } },
      },
    };
    const consoleError = sinon.stub(console, 'error');

    try {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('importedPathRouter.ts')],
        TSCONFIG_PATH
      );
      sinon.assert.notCalled(consoleError);
    } finally {
      consoleError.restore();
    }

    const gadgetSchema =
      doc.paths['/gadgets/{gadget_id}'].get?.responses?.['200'].content[
        'application/json'
      ].schema;
    expect(gadgetSchema).to.eql({ $ref: '#/components/schemas/Gadget' });
    expect(doc.components.schemas?.Gadget).to.eql({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('resolves a path built from an extensionless relative import', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    doc.paths['/doohickeys/{widget_id}'] = {
      get: {
        summary: 'Get a doohickey',
        responses: { 200: { description: 'The doohickey' } },
      },
    };
    const consoleError = sinon.stub(console, 'error');

    try {
      applyGeneratedResponseSchemas(
        doc,
        [path.join(CJS_STYLE_DIR, 'router.ts')],
        CJS_STYLE_TSCONFIG_PATH
      );
      sinon.assert.notCalled(consoleError);
    } finally {
      consoleError.restore();
    }

    const doohickeySchema =
      doc.paths['/doohickeys/{widget_id}'].get?.responses?.['200'].content[
        'application/json'
      ].schema;
    expect(doohickeySchema).to.eql({
      $ref: '#/components/schemas/Doohickey',
    });
  });

  it('throws when the withResponses type argument is a named type', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });

    expect(() => {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('namedAliasRouter.ts')],
        TSCONFIG_PATH
      );
    }).to.throw(/inline object type literal/);
  });

  it('throws when a response type is a generic instantiation instead of a concrete alias', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    doc.paths['/generic-instantiation'] = {
      get: { responses: { 200: { description: 'OK' } } },
    };

    expect(() => {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('genericInstantiationRouter.ts')],
        TSCONFIG_PATH
      );
    }).to.throw(/generic instantiation/);
  });

  it('throws when a response type is an inline union', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    doc.paths['/unsupported-shape'] = {
      get: { responses: { 200: { description: 'OK' } } },
    };

    expect(() => {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('unsupportedShapeRouter.ts')],
        TSCONFIG_PATH
      );
    }).to.throw(/unsupported response type shape/);
  });

  it('throws when Responses declares a status with no matching responses[status] entry', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    doc.paths['/missing-description'] = {
      get: { responses: { 200: { description: 'OK' } } },
    };

    expect(() => {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('missingDescriptionRouter.ts')],
        TSCONFIG_PATH
      );
    }).to.throw(/declares 404 in withResponses/);
  });

  it("logs and skips a call whose docPath can't be resolved", () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    const consoleError = sinon.stub(console, 'error');

    try {
      expect(() => {
        applyGeneratedResponseSchemas(
          doc,
          [fixture('unresolvableDocPathRouter.ts')],
          TSCONFIG_PATH
        );
      }).not.to.throw();
      sinon.assert.calledWith(
        consoleError,
        sinon.match(/couldn't statically resolve docPath\/method/)
      );
    } finally {
      consoleError.restore();
    }
  });

  it('skips other calls that cannot be resolved', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    const consoleError = sinon.stub(console, 'error');

    try {
      expect(() => {
        applyGeneratedResponseSchemas(
          doc,
          [fixture('miscUnresolvableRouter.ts')],
          TSCONFIG_PATH
        );
      }).not.to.throw();
      // An imported prefix and a bare-root path with no prefix resolve to an
      // empty docPath, and a function-call path doesn't resolve; all three log
      // the same message. A def passed as a variable is skipped without a
      // message.
      sinon.assert.calledWith(
        consoleError,
        sinon.match(/couldn't statically resolve docPath\/method/)
      );
      sinon.assert.calledWith(
        consoleError,
        sinon.match(/has no matching operation in the built document/)
      );
    } finally {
      consoleError.restore();
    }
  });

  it('logs and skips a call that matches no operation in the document', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    // No paths are seeded, so none of basicRouter.ts's routes match.
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    const consoleError = sinon.stub(console, 'error');

    try {
      expect(() => {
        applyGeneratedResponseSchemas(
          doc,
          [fixture('basicRouter.ts')],
          TSCONFIG_PATH
        );
      }).not.to.throw();
      sinon.assert.calledWith(
        consoleError,
        sinon.match(/has no matching operation in the built document/)
      );
    } finally {
      consoleError.restore();
    }
  });

  it('throws for a file that does not exist', () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });

    expect(() => {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('doesNotExist.ts')],
        TSCONFIG_PATH
      );
    }).to.throw(/no such file/);
  });

  it("uses the type's shape when its toJSON property isn't callable", () => {
    const { buildOpenApiDocument } = createRouteRegistry();
    const doc = buildOpenApiDocument({ title: 't', version: '1' });
    doc.paths['/non-callable-tojson'] = {
      get: { responses: { 200: { description: 'OK' } } },
    };
    const consoleError = sinon.stub(console, 'error');

    try {
      applyGeneratedResponseSchemas(
        doc,
        [fixture('nonCallableToJsonRouter.ts')],
        TSCONFIG_PATH
      );
      sinon.assert.calledWith(
        consoleError,
        sinon.match(/isn't callable -- generating from its own shape instead/)
      );
      expect(doc.components.schemas?.NonCallableToJson).to.eql({
        type: 'object',
        properties: {
          toJSON: { type: 'string' },
          other: { type: 'number' },
        },
        required: ['toJSON', 'other'],
        additionalProperties: false,
      });
    } finally {
      consoleError.restore();
    }
  });
});

describe('UNIT: fileLooksLikeItUsesWithResponses', () => {
  it('is true for a file containing a withResponses call', () => {
    expect(fileLooksLikeItUsesWithResponses(fixture('basicRouter.ts'))).to.be
      .true;
  });

  it('is false for a file with no withResponses call', () => {
    expect(
      fileLooksLikeItUsesWithResponses(
        path.join(FIXTURES_DIR, '..', 'security.spec.ts')
      )
    ).to.be.false;
  });
});
