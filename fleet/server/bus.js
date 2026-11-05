import { EventEmitter } from 'node:events';

// One channel per company, so a live event can never reach another company's stream.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const publish = (companyId, event) => bus.emit(companyId, event);
