import _ from 'lodash';
import { TAPi18n } from 'meteor/rocketchat:tap-i18n';

import { IEDataRoom } from '../../../events/definitions/data/IEDataRoom';
import { IEDataMessage } from '../../../events/definitions/data/IEDataMessage';
import { EDataDefinition, EventTypeDescriptor, IEData, IEvent } from '../../../events/definitions/IEvent';
import { IRoom } from '../../../events/definitions/IRoom';
import { getLocalSrc } from '../../../events/server/lib/getLocalSrc';
import { IAddEventResult, IContextQuery, EventsModel, IEventStub } from './Events';
import { IEDataUpdate } from '../../../events/definitions/data/IEDataUpdate';
import { IEDataEmpty } from '../../../events/definitions/data/IDataEmpty';

const getContextQuery = (param: string | IEvent<any>): IContextQuery => {
	let rid: string;

	if (typeof param === 'string') {
		rid = param;
	} else {
		rid = param.rid;
	}

	return { rid };
};

class RoomEventsModel extends EventsModel {
	readonly v1ToV2RootMap = ['_cid' /* this is the old _id, now it is called "client id" because it is generated by the client */, '_pids', 'v', 'ts', 'src', 'rid', 't', 'd', '_updatedAt', '_deletedAt'];

	constructor() {
		super('room_event');

		this.tryEnsureIndex({ rid: 1, ts: 1 });
		this.tryEnsureIndex({ 'd.u._id': 1 }, { sparse: true });
		this.tryEnsureIndex({ rid: 1, t: 1, 'd.u._id': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'd.expireAt': 1 }, { expireAfterSeconds: 0 });
		this.tryEnsureIndex({ 'd.msg': 'text' }, { sparse: true });
		this.tryEnsureIndex({ 'd.file._id': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'd.mentions.username': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'd.pinned': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'd.snippeted': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'd.location': '2dsphere' });
		this.tryEnsureIndex({ 'd.unread': 1 }, { sparse: true });

		// slack bridge
		this.tryEnsureIndex({ 'd.slackBotId': 1, 'd.slackTs': 1 }, { sparse: true });

		// discussions
		this.tryEnsureIndex({ 'd.drid': 1 }, { sparse: true });
		// threads
		this.tryEnsureIndex({ 'd.tmid': 1 }, { sparse: true });
		this.tryEnsureIndex({ 'd.tcount': 1, tlm: 1 }, { sparse: true });
		// livechat
		this.tryEnsureIndex({ 'd.navigation.token': 1 }, { sparse: true });
	}

	public ensureSrc(src: string) {
		return src || getLocalSrc();
	}

	public async addRoomEvent<T extends EDataDefinition>(event: IEvent<T>): Promise<IAddEventResult> {
		return super.addEvent(getContextQuery(event), event);
	}

	public async updateRoomEventData<T extends EDataDefinition>(event: IEvent<T>, dataToUpdate: IEDataUpdate<IEData>): Promise<void> {
		return super.updateEventData(getContextQuery(event), event.t, dataToUpdate, event._cid);
	}

	public async flagRoomEventAsDeleted<T extends EDataDefinition>(event: IEvent<T>): Promise<void> {
		return super.flagEventAsDeleted(getContextQuery(event), event.t, new Date(), event._cid);
	}

	public async createRoomGenesisEvent(src: string, room: IRoom): Promise<IEvent<IEDataRoom>> {
		src = this.ensureSrc(src);

		const event: IEDataRoom = { room };

		return super.createGenesisEvent(src, getContextQuery(room._id), event);
	}

	public async createMessageEvent<T extends IEDataMessage>(src: string, roomId: string, _cid: string, d: T): Promise<IEvent<T>> {
		src = this.ensureSrc(src);

		const stub: IEventStub<T> = {
			_cid,
			t: EventTypeDescriptor.MESSAGE,
			d,
		};

		return super.createEvent(src, getContextQuery(roomId), stub);
	}

	public async createEditMessageEvent<T extends IEDataUpdate<IEDataMessage>>(src: string, roomId: string, _cid: string, d: T): Promise<IEvent<T>> {
		src = this.ensureSrc(src);

		const stub: IEventStub<T> = {
			_cid,
			t: EventTypeDescriptor.EDIT_MESSAGE,
			d,
		};

		return super.createEvent(src, getContextQuery(roomId), stub);
	}

	public async createDeleteMessageEvent(src: string, roomId: string, _cid?: string): Promise<IEvent<IEDataUpdate<IEDataEmpty>>> {
		src = this.ensureSrc(src);

		const stub: IEventStub<IEDataUpdate<IEDataEmpty>> = {
			_cid,
			t: EventTypeDescriptor.DELETE_MESSAGE,
			d: {},
		};

		return super.createEvent(src, getContextQuery(roomId), stub);
	}

	public async createDeleteRoomEvent(src: string, roomId: string): Promise<IEvent<IEDataUpdate<IEDataEmpty>>> {
		src = this.ensureSrc(src);

		const stub: IEventStub<IEDataUpdate<IEDataEmpty>> = {
			t: EventTypeDescriptor.DELETE_ROOM,
			d: {},
		};

		return super.createEvent(src, getContextQuery(roomId), stub);
	}

	public async createPruneMessagesEvent(query: any, roomId: string): Promise<{
		count: number;
		filesIds: Array<string>;
		discussionsIds: Array<string>;
	}> {
		const pruneEvent = await super.createEvent(getLocalSrc(), getContextQuery(roomId), {
			t: EventTypeDescriptor.PRUNE_ROOM_MESSAGES,
			d: {
				query: JSON.stringify(query),
			},
		});

		this.addRoomEvent(pruneEvent);

		const filesIds: Array<string> = [];
		const discussionsIds: Array<string> = [];
		const modifier = (event: IEvent<EDataDefinition>): {[key: string]: Function} => ({
			msg: (): void => {
				this.update({
					_id: event._id,
				}, {
					$set: {
						'd.msg': '',
					},
					$currentDate: { _deletedAt: true },
				});
			},
			discussion: (): void => {
				const { d = {} } = event;
				const { drid } = d;
				discussionsIds.push(drid);
				this.update({
					_id: event._id,
				}, {
					$currentDate: { _deletedAt: true },
				});
			},
			file: (): void => {
				const { d = {} } = event;
				const { file = {} } = d;
				filesIds.push(file._id);
				this.update({
					_id: event._id,
				}, {
					$unset: { 'd.file': 1 },
					$set: { 'd.attachments': [{ color: '#FD745E', prunedText: `_${ TAPi18n.__('File_removed_by_prune') }_` }] },
					$currentDate: { _deletedAt: true },
				});
			},
		});

		const results: Array<IEvent<EDataDefinition>> = await this.model.rawCollection().find({
			'd.msg': { $exists: true },
			...query,
		}).toArray();

		for (let i = 0; results.length > i; i++) {
			// identify what type of data is the current one
			const { d: data } = results[i];
			if (data && data.file && data.file._id) {
				modifier(results[i]).file();
				continue;
			} else if (data && data.drid) {
				modifier(results[i]).discussion();
				continue;
			} else {
				modifier(results[i]).msg();
				continue;
			}
		}

		return {
			count: results.length,
			filesIds,
			discussionsIds,
		};
	}

	// async createAddUserEvent(src, roomId, user, subscription, domainsAfterAdd) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_ADD_USER, { roomId, user, subscription, domainsAfterAdd });
	// }

	// async createRemoveUserEvent(src, roomId, user, domainsAfterRemoval) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_REMOVE_USER, { roomId, user, domainsAfterRemoval });
	// }

	// async createDeleteMessageEvent(src, roomId, messageId) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_DELETE_MESSAGE, { roomId, messageId });
	// }

	// async createSetMessageReactionEvent(src, roomId, messageId, username, reaction) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_SET_MESSAGE_REACTION, { roomId, messageId, username, reaction });
	// }

	// async createUnsetMessageReactionEvent(src, roomId, messageId, username, reaction) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_UNSET_MESSAGE_REACTION, { roomId, messageId, username, reaction });
	// }

	// async createMuteUserEvent(src, roomId, user) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_MUTE_USER, { roomId, user });
	// }

	// async createUnmuteUserEvent(src, roomId, user) {
	// 	return super.createEvent(src, getContextQuery(roomId), eventTypes.ROOM_UNMUTE_USER, { roomId, user });
	// }

	// async removeRoomEvents(roomId) {
	// 	return super.removeContextEvents(getContextQuery(roomId));
	// }

	//
	// Backwards compatibility
	//
	public belongsToV2Root(property: string): boolean {
		return this.v1ToV2RootMap.indexOf(property) !== -1;
	}

	public fromV1Data(message: IEDataMessage): IEDataMessage {
		return { ..._.omit(message, this.v1ToV2RootMap), t: message.t || 'msg', u: message.u, msg: message.msg, _msgSha: '' };
	}

	public toV1(event: any) {
		return {
			..._.omit(event, 'd'),
			...event.d,
			t: (event.d || {}).t,
		};
	}
}

export const RoomEvents = new RoomEventsModel();
