import { main, runService } from '@am/platform/node';
import { defineMcpService } from './service.js';

main(() => runService(defineMcpService()));
