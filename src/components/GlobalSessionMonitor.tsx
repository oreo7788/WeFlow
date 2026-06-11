import { useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import type { ChatSession, Message } from '../types/models'
const SESSION_REFRESH_DEBOUNCE_MS = 300

export function GlobalSessionMonitor() {
    const isShuttingDownRef = useRef(false)
    const refreshTimerRef = useRef<number | null>(null)
    const refreshInFlightRef = useRef(false)
    const refreshQueuedRef = useRef(false)
    const {
        sessions,
        setSessions,
        appendMessages
    } = useChatStore()

    const sessionsRef = useRef(sessions)
    useEffect(() => {
        sessionsRef.current = sessions
    }, [sessions])

    const getMessageKey = (msg: Message) => {
        if (msg.messageKey) return msg.messageKey
        return `fallback:${msg._db_path || ''}:${msg.serverId || 0}:${msg.createTime}:${msg.sortSeq || 0}:${msg.localId || 0}:${msg.senderUsername || ''}:${msg.localType || 0}`
    }

    const handleActiveSessionRefresh = useCallback(async (sessionId: string) => {
        const state = useChatStore.getState()
        const msgs = state.messages || []
        const lastMsg = msgs[msgs.length - 1]
        const minTime = lastMsg?.createTime || 0

        try {
            const result = await (window.electronAPI.chat as any).getNewMessages(sessionId, minTime)
            if (result.success && result.messages && result.messages.length > 0) {
                const latestMessages = useChatStore.getState().messages || []
                const existingKeys = new Set(latestMessages.map(getMessageKey))
                const newMessages = result.messages.filter((msg: Message) => !existingKeys.has(getMessageKey(msg)))
                if (newMessages.length > 0) {
                    appendMessages(newMessages, false)
                }
            }
        } catch (e) {
            console.warn('后台活跃会话刷新失败:', e)
        }
    }, [appendMessages])

    const applySessionUpdates = useCallback(async (newSessions: ChatSession[]) => {
        const oldSessions = sessionsRef.current
        await checkForNewMessages(oldSessions, newSessions)
        setSessions(newSessions)

        const currentId = useChatStore.getState().currentSessionId
        if (currentId) {
            const currentSessionNew = newSessions.find(s => s.username === currentId)
            const currentSessionOld = oldSessions.find(s => s.username === currentId)

            if (currentSessionNew && (!currentSessionOld || currentSessionNew.lastTimestamp > currentSessionOld.lastTimestamp)) {
                void handleActiveSessionRefresh(currentId)
            }
        }
    }, [handleActiveSessionRefresh, setSessions])

    const refreshSessions = useCallback(async () => {
        if (isShuttingDownRef.current) return
        if (refreshInFlightRef.current) {
            refreshQueuedRef.current = true
            return
        }

        refreshInFlightRef.current = true
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions && Array.isArray(result.sessions)) {
                await applySessionUpdates(result.sessions as ChatSession[])
            }
        } catch (e) {
            console.error('全局会话刷新失败:', e)
        } finally {
            refreshInFlightRef.current = false
            if (refreshQueuedRef.current) {
                refreshQueuedRef.current = false
                void refreshSessions()
            }
        }
    }, [applySessionUpdates])

    const scheduleRefreshSessions = useCallback(() => {
        if (refreshTimerRef.current !== null) {
            window.clearTimeout(refreshTimerRef.current)
        }
        refreshTimerRef.current = window.setTimeout(() => {
            refreshTimerRef.current = null
            void refreshSessions()
        }, SESSION_REFRESH_DEBOUNCE_MS)
    }, [refreshSessions])

    useEffect(() => {
        const handleDbChange = (_event: unknown, data: { type: string; json: string }) => {
            if (isShuttingDownRef.current) return
            try {
                const payload = JSON.parse(data.json)
                const tableName = payload.table

                if (tableName === 'Session' || tableName === 'session') {
                    scheduleRefreshSessions()
                }
            } catch (e) {
                console.error('解析数据库变更失败:', e)
            }
        }

        if (window.electronAPI.chat.onWcdbChange) {
            const removeListener = window.electronAPI.chat.onWcdbChange(handleDbChange)
            return () => {
                removeListener()
                if (refreshTimerRef.current !== null) {
                    window.clearTimeout(refreshTimerRef.current)
                    refreshTimerRef.current = null
                }
            }
        }
        return () => {
            if (refreshTimerRef.current !== null) {
                window.clearTimeout(refreshTimerRef.current)
                refreshTimerRef.current = null
            }
        }
    }, [scheduleRefreshSessions])

    useEffect(() => {
        const removeListener = window.electronAPI?.app?.onShuttingDown?.(() => {
            isShuttingDownRef.current = true
        })
        return () => removeListener?.()
    }, [])

    useEffect(() => {
        const removeListener = window.electronAPI.chat.onSessionsEnriched?.((_event, data) => {
            if (isShuttingDownRef.current) return
            if (!Array.isArray(data.sessions) || data.sessions.length === 0) return
            void applySessionUpdates(data.sessions as ChatSession[])
        })
        return () => removeListener?.()
    }, [applySessionUpdates])

    const checkForNewMessages = async (oldSessions: ChatSession[], newSessions: ChatSession[]) => {
        if (!oldSessions || oldSessions.length === 0) {
            console.log('[NotificationFilter] Skipping check on initial load (empty baseline)')
            return
        }

        const oldMap = new Map(oldSessions.map(s => [s.username, s]))

        for (const newSession of newSessions) {
            const oldSession = oldMap.get(newSession.username)

            const isCurrentSession = newSession.username === useChatStore.getState().currentSessionId

            if (!isCurrentSession && (!oldSession || newSession.lastTimestamp > oldSession.lastTimestamp)) {
                if (newSession.isMuted || newSession.isFolded) continue
                if (newSession.username.toLowerCase().includes('placeholder_foldgroup')) continue

                if (newSession.username.includes('@chatroom')) {
                    if (newSession.lastMsgSender && newSession.selfWxid) {
                        const sender = newSession.lastMsgSender.replace(/^wxid_/, '');
                        const self = newSession.selfWxid.replace(/^wxid_/, '');

                        const debugInfo = {
                            type: 'NotificationFilter',
                            username: newSession.username,
                            lastMsgSender: newSession.lastMsgSender,
                            selfWxid: newSession.selfWxid,
                            senderClean: sender,
                            selfClean: self,
                            match: sender === self
                        };

                        if (window.electronAPI.log?.debug) {
                            window.electronAPI.log.debug(debugInfo);
                        } else {
                            console.log('[NotificationFilter]', debugInfo);
                        }

                        if (sender === self) {
                            if (window.electronAPI.log?.debug) {
                                window.electronAPI.log.debug('[NotificationFilter] Filtered own message');
                            } else {
                                console.log('[NotificationFilter] Filtered own message');
                            }
                            continue;
                        }
                    } else {
                        const missingInfo = {
                            type: 'NotificationFilter Missing info',
                            lastMsgSender: newSession.lastMsgSender,
                            selfWxid: newSession.selfWxid
                        };
                        if (window.electronAPI.log?.debug) {
                            window.electronAPI.log.debug(missingInfo);
                        } else {
                            console.log('[NotificationFilter] Missing info:', missingInfo);
                        }
                    }
                }

                const oldUnread = oldSession ? oldSession.unreadCount : 0
                const newUnread = newSession.unreadCount
                if (newUnread <= oldUnread) {
                    continue
                }

                let title = newSession.displayName || newSession.username
                let avatarUrl = newSession.avatarUrl
                let content = newSession.summary || '[新消息]'

                if (newSession.username.includes('@chatroom')) {
                    const cleanWxid = (id: string) => {
                        if (!id) return '';
                        const trimmed = id.trim();
                        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/);
                        return suffixMatch ? suffixMatch[1] : trimmed;
                    }

                    if (newSession.lastMsgSender && newSession.selfWxid) {
                        const senderClean = cleanWxid(newSession.lastMsgSender);
                        const selfClean = cleanWxid(newSession.selfWxid);
                        const match = senderClean === selfClean;

                        if (match) {
                            continue;
                        }
                    }

                    if (newSession.lastSenderDisplayName) {
                        content = `${newSession.lastSenderDisplayName}: ${content}`
                    }
                }

                const needsEnrichment = !newSession.displayName || !newSession.avatarUrl || newSession.displayName === newSession.username

                if (needsEnrichment && newSession.username) {
                    try {
                        const contact = await window.electronAPI.chat.getContact(newSession.username)
                        if (contact) {
                            if (contact.remark || contact.nickName) {
                                title = contact.remark || contact.nickName
                            }
                            const avatarResult = await window.electronAPI.chat.getContactAvatar(newSession.username)
                            if (avatarResult?.avatarUrl) {
                                avatarUrl = avatarResult.avatarUrl
                            }
                        } else {
                            const enrichResult = await window.electronAPI.chat.enrichSessionsContactInfo([newSession.username])
                            if (enrichResult.success && enrichResult.contacts) {
                                const enrichedContact = enrichResult.contacts[newSession.username]
                                if (enrichedContact) {
                                    if (enrichedContact.displayName) {
                                        title = enrichedContact.displayName
                                    }
                                    if (enrichedContact.avatarUrl) {
                                        avatarUrl = enrichedContact.avatarUrl
                                    }
                                }
                            }
                            if (title === newSession.username || title.startsWith('wxid_')) {
                                const retried = await window.electronAPI.chat.getContact(newSession.username)
                                if (retried) {
                                    title = retried.remark || retried.nickName || title
                                    const retriedAvatar = await window.electronAPI.chat.getContactAvatar(newSession.username)
                                    if (retriedAvatar?.avatarUrl) {
                                        avatarUrl = retriedAvatar.avatarUrl
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('获取通知的联系人信息失败', e)
                    }
                }

                const isGroupChat = newSession.username.includes('@chatroom')
                const isWxidTitle = title.startsWith('wxid_') && title === newSession.username
                if (isWxidTitle && !isGroupChat) {
                    console.warn('[NotificationFilter] 跳过无法识别的用户通知:', newSession.username)
                    continue
                }

                window.electronAPI.notification?.show({
                    title: title,
                    content: content,
                    avatarUrl: avatarUrl,
                    sessionId: newSession.username
                })
            }
        }
    }

    return null
}
