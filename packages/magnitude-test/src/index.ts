// Needed for React to work properly
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
<<<<<<< HEAD
export { test } from '@/worker/testDeclaration';
=======
export {
    test,
    beforeAll,
    afterAll,
    beforeEach,
    afterEach,
} from '@/worker/testDeclaration';
>>>>>>> Bremote/main
export { type MagnitudeConfig, type WebServerConfig } from '@/discovery/types';
