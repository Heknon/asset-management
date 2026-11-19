import { main, runService } from '@am/platform/node';
import { registryService } from './service.js';

main(() => runService(registryService));
