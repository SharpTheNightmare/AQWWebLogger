import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  Activity, 
  Bot, 
  Circle, 
  Loader2, 
  MessageSquare, 
  Play, 
  Send, 
  Shield, 
  Trash2, 
  User,
  Zap
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ClientStatus {
  loaded: boolean;
  logged: boolean;
  scriptRunning: boolean;
  loadedScript: string;
}

interface Client {
  id: string;
  name: string;
  status: ClientStatus;
  logs: string[];
  connected: boolean;
}

interface AppState {
  clients: Record<string, Client>;
  masterLogs: string[];
  activeClient: string | null;
  wsStatus: 'connecting' | 'connected' | 'disconnected';
  debugInfo: string[];
}

type AppAction = 
  | { type: 'CLIENT_CONNECT'; payload: { id: string; name?: string } }
  | { type: 'CLIENT_DISCONNECT'; payload: { id: string } }
  | { type: 'UPDATE_TAB_NAME'; payload: { id: string; name: string } }
  | { type: 'UPDATE_STATUS'; payload: { id: string; field: string; value: any } }
  | { type: 'ADD_CLIENT_LOG'; payload: { id: string; message: string } }
  | { type: 'ADD_MASTER_LOG'; payload: { message: string } }
  | { type: 'CLEAR_MASTER_LOG' }
  | { type: 'SET_ACTIVE_CLIENT'; payload: { id: string | null } }
  | { type: 'SET_WS_STATUS'; payload: { status: 'connecting' | 'connected' | 'disconnected' } }
  | { type: 'ADD_DEBUG_INFO'; payload: { message: string } };

const initialState: AppState = {
  clients: {},
  masterLogs: [],
  activeClient: null,
  wsStatus: 'connecting',
  debugInfo: []
};

function appReducer(state: AppState, action: AppAction): AppState {
  try {
    switch (action.type) {
      case 'CLIENT_CONNECT':
        const newClient = {
          id: action.payload.id,
          name: action.payload.name || action.payload.id,
          status: { loaded: false, logged: false, scriptRunning: false, loadedScript: '' },
          logs: [],
          connected: true
        };
        
        return {
          ...state,
          clients: { ...state.clients, [action.payload.id]: newClient },
          activeClient: state.activeClient || action.payload.id
        };

      case 'CLIENT_DISCONNECT':
        const { [action.payload.id]: removedClient, ...remainingClients } = state.clients;
        const remainingIds = Object.keys(remainingClients);
        
        return {
          ...state,
          clients: remainingClients,
          activeClient: state.activeClient === action.payload.id 
            ? (remainingIds.length > 0 ? remainingIds[0] : null)
            : state.activeClient
        };

      case 'UPDATE_TAB_NAME':
        if (!state.clients[action.payload.id]) return state;
        
        return {
          ...state,
          clients: {
            ...state.clients,
            [action.payload.id]: {
              ...state.clients[action.payload.id],
              name: action.payload.name
            }
          }
        };

      case 'UPDATE_STATUS':
        if (!state.clients[action.payload.id]) return state;
        
        return {
          ...state,
          clients: {
            ...state.clients,
            [action.payload.id]: {
              ...state.clients[action.payload.id],
              status: {
                ...state.clients[action.payload.id].status,
                [action.payload.field]: action.payload.value
              }
            }
          }
        };

      case 'ADD_CLIENT_LOG':
        if (!state.clients[action.payload.id]) return state;
        
        return {
          ...state,
          clients: {
            ...state.clients,
            [action.payload.id]: {
              ...state.clients[action.payload.id],
              logs: [...state.clients[action.payload.id].logs, action.payload.message]
            }
          }
        };

      case 'ADD_MASTER_LOG':
        return {
          ...state,
          masterLogs: [...state.masterLogs, action.payload.message]
        };

      case 'CLEAR_MASTER_LOG':
        return {
          ...state,
          masterLogs: []
        };

      case 'SET_ACTIVE_CLIENT':
        return {
          ...state,
          activeClient: action.payload.id
        };

      case 'SET_WS_STATUS':
        return {
          ...state,
          wsStatus: action.payload.status
        };

      case 'ADD_DEBUG_INFO':
        const timestamp = new Date().toLocaleTimeString();
        return {
          ...state,
          debugInfo: [...state.debugInfo.slice(-9), `${timestamp}: ${action.payload.message}`]
        };

      default:
        return state;
    }
  } catch (error) {
    console.error('Error in reducer:', error, action);
    return state;
  }
}

export const BotLogger: React.FC = () => {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { user, logout } = useAuth();
  const [messageInput, setMessageInput] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const masterLogRef = useRef<HTMLDivElement>(null);
  const clientLogRefs = useRef<Record<string, HTMLDivElement>>({});

  // Check if debug mode is enabled via URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pathname = window.location.pathname;
    setShowDebug(params.has('debug') || pathname.includes('/debug'));
  }, []);

  // Debug logger
  const addDebugInfo = useCallback((message: string) => {
    console.log(`[BotLogger Debug]: ${message}`);
    dispatch({ type: 'ADD_DEBUG_INFO', payload: { message } });
  }, []);

  // Process WebSocket messages
  const processMessage = useCallback((data: any) => {
    try {
      addDebugInfo(`Processing message: ${data.type} for client: ${data.id || 'N/A'}`);
      
      switch (data.type) {
        case 'client_connect':
          addDebugInfo(`Client connecting: ${data.id} (${data.name})`);
          dispatch({ 
            type: 'CLIENT_CONNECT', 
            payload: { id: data.id, name: data.name } 
          });
          break;

        case 'client_disconnect':
          addDebugInfo(`Client disconnecting: ${data.id}`);
          dispatch({ 
            type: 'CLIENT_DISCONNECT', 
            payload: { id: data.id } 
          });
          break;

        case 'update_tab_name':
          addDebugInfo(`Updating tab name for ${data.id}: ${data.name}`);
          dispatch({ 
            type: 'UPDATE_TAB_NAME', 
            payload: { id: data.id, name: data.name } 
          });
          break;

        case 'update_status':
          addDebugInfo(`Updating status for ${data.id}: ${data.field} = ${data.value}`);
          dispatch({ 
            type: 'UPDATE_STATUS', 
            payload: { id: data.id, field: data.field, value: data.value } 
          });
          break;


        case 'status_update_json':
          addDebugInfo(`JSON Status update for ${data.id} - Changes: ${Object.keys(data.changes || {}).join(', ')}`);
          
          // Update tab name if client name is included
          if (data.status && data.status.clientName && data.status.clientName !== state.clients[data.id]?.name) {
            dispatch({ 
              type: 'UPDATE_TAB_NAME', 
              payload: { id: data.id, name: data.status.clientName } 
            });
          }
          
          // Update individual status fields
          Object.keys(data.changes || {}).forEach(field => {
            dispatch({ 
              type: 'UPDATE_STATUS', 
              payload: { id: data.id, field: field, value: data.changes[field] } 
            });
          });
          break;
        case 'log':
          addDebugInfo(`Adding log for ${data.id}: ${data.message.substring(0, 50)}...`);
          dispatch({ 
            type: 'ADD_CLIENT_LOG', 
            payload: { id: data.id, message: data.message } 
          });
          break;

        case 'master_log':
          addDebugInfo(`Adding master log: ${data.message.substring(0, 50)}...`);
          dispatch({ 
            type: 'ADD_MASTER_LOG', 
            payload: { message: data.message } 
          });
          break;

        case 'clear_master_log':
          addDebugInfo('Clearing master log');
          dispatch({ type: 'CLEAR_MASTER_LOG' });
          break;

        default:
          addDebugInfo(`Unknown message type: ${data.type}`);
          console.warn('Unknown WebSocket message type:', data.type);
      }
    } catch (error) {
      const errorMsg = `Error processing message ${data.type}: ${error instanceof Error ? error.message : String(error)}`;
      addDebugInfo(errorMsg);
      console.error('Error processing message:', error, data);
    }
  }, [addDebugInfo]);

  // WebSocket connection
  useEffect(() => {
    const connectWebSocket = () => {
      try {
        addDebugInfo('Attempting to connect WebSocket...');
        const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${wsProtocol}://${location.host}/ws/`;
        addDebugInfo(`WebSocket URL: ${wsUrl}`);
        
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          addDebugInfo('WebSocket connected successfully');
          dispatch({ type: 'SET_WS_STATUS', payload: { status: 'connected' } });
        };

        ws.onmessage = (event) => {
          try {
            addDebugInfo(`Received WebSocket message: ${event.data.substring(0, 100)}...`);
            const data = JSON.parse(event.data);
            processMessage(data);
          } catch (error) {
            const errorMsg = `Error parsing WebSocket message: ${error instanceof Error ? error.message : String(error)}`;
            addDebugInfo(errorMsg);
            console.error('Error parsing WebSocket message:', error);
          }
        };

        ws.onclose = (event) => {
          addDebugInfo(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
          dispatch({ type: 'SET_WS_STATUS', payload: { status: 'disconnected' } });
          setTimeout(() => {
            addDebugInfo('Attempting to reconnect WebSocket...');
            connectWebSocket();
          }, 3000);
        };

        ws.onerror = (error) => {
          addDebugInfo(`WebSocket error occurred`);
          console.error('WebSocket error:', error);
          dispatch({ type: 'SET_WS_STATUS', payload: { status: 'disconnected' } });
        };
      } catch (error) {
        const errorMsg = `Error creating WebSocket: ${error instanceof Error ? error.message : String(error)}`;
        addDebugInfo(errorMsg);
        console.error('Error creating WebSocket:', error);
        dispatch({ type: 'SET_WS_STATUS', payload: { status: 'disconnected' } });
        setTimeout(() => {
          addDebugInfo('Retrying WebSocket connection after error...');
          connectWebSocket();
        }, 3000);
      }
    };

    addDebugInfo('Initializing WebSocket connection...');
    connectWebSocket();
    
    return () => {
      addDebugInfo('Cleaning up WebSocket connection...');
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [addDebugInfo, processMessage]);

  // Auto-scroll logs
  useEffect(() => {
    if (masterLogRef.current) {
      masterLogRef.current.scrollTop = masterLogRef.current.scrollHeight;
    }
  }, [state.masterLogs]);

  useEffect(() => {
    if (state.activeClient && clientLogRefs.current[state.activeClient]) {
      const ref = clientLogRefs.current[state.activeClient];
      if (ref) {
        ref.scrollTop = ref.scrollHeight;
      }
    }
  }, [state.clients, state.activeClient]);

  const sendMessage = () => {
    if (!messageInput.trim() || !state.activeClient || !wsRef.current) return;

    try {
      addDebugInfo(`Sending message to client ${state.activeClient}: ${messageInput}`);
      wsRef.current.send(JSON.stringify({
        type: 'send_to_client',
        id: state.activeClient,
        message: messageInput.trim()
      }));
      setMessageInput('');
    } catch (error) {
      const errorMsg = `Error sending message: ${error instanceof Error ? error.message : String(error)}`;
      addDebugInfo(errorMsg);
      console.error('Error sending message:', error);
    }
  };

  const clearMasterLog = () => {
    if (!wsRef.current) return;
    
    try {
      addDebugInfo('Clearing master log...');
      wsRef.current.send(JSON.stringify({ type: 'clear_master_log' }));
    } catch (error) {
      const errorMsg = `Error clearing master log: ${error instanceof Error ? error.message : String(error)}`;
      addDebugInfo(errorMsg);
      console.error('Error clearing master log:', error);
    }
  };

  const getStatusIcon = (status: ClientStatus) => {
    if (status.scriptRunning) return <Play className="w-4 h-4 text-green-500" />;
    if (status.logged) return <Shield className="w-4 h-4 text-green-500" />;
    if (status.loaded) return <Activity className="w-4 h-4 text-green-500" />;
    return <Circle className="w-4 h-4 text-muted-foreground" />;
  };

  const StatusBadge: React.FC<{ label: string; active: boolean }> = ({ label, active }) => (
    <Badge 
      className={cn(
        "text-xs font-medium border",
        active 
          ? "bg-green-500 text-white border-green-500" 
          : "bg-red-500 text-white border-red-500"
      )}
    >
      {label}
    </Badge>
  );

  const clientEntries = Object.entries(state.clients);

  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <Bot className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              AQW Bot Logger
            </h1>
          </div>
          <Badge 
            variant={state.wsStatus === 'connected' ? 'default' : 'destructive'}
            className={cn(
              "transition-all duration-300",
              state.wsStatus === 'connected' && "bg-success text-success-foreground"
            )}
          >
            {state.wsStatus === 'connecting' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {state.wsStatus}
          </Badge>
        </div>
        
        <div className="flex items-center space-x-4">
          <div className="text-sm text-muted-foreground">
            {clientEntries.length} client(s) connected
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground">Welcome, {user?.username}</span>
            <Button variant="outline" size="sm" onClick={logout}>
              Logout
            </Button>
          </div>
        </div>
      </div>

      {/* Debug Info Panel - Only show if /debug in URL */}
      {showDebug && (
        <Card className="bg-muted/20">
          <CardHeader>
            <CardTitle className="text-sm">Debug Information</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-32 w-full">
              <div className="space-y-1">
                {state.debugInfo.map((info, index) => (
                  <div key={index} className="text-xs font-mono text-muted-foreground">
                    {info}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Main Content */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Client Management */}
        <div className="xl:col-span-2 space-y-4">
          <Card className="animate-slide-up">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <User className="w-5 h-5" />
                <span>Connected Clients</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {clientEntries.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No clients connected
                </div>
              ) : (
                <Tabs value={state.activeClient || ''} onValueChange={(value) => 
                  dispatch({ type: 'SET_ACTIVE_CLIENT', payload: { id: value } })
                }>
                  <TabsList className="flex flex-wrap w-full gap-1 h-auto p-1">
                    {clientEntries.map(([id, client]) => (
                      <TabsTrigger 
                        key={id} 
                        value={id} 
                        className="flex items-center space-x-2 transition-all duration-300 flex-shrink-0 min-w-0"
                      >
                        {getStatusIcon(client.status)}
                        <span className="truncate max-w-[8rem]">{client.name}</span>
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  {clientEntries.map(([id, client]) => (
                    <TabsContent key={id} value={id} className="mt-4 space-y-4">
                      {/* Client Status */}
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-lg flex items-center justify-between">
                            <span>{client.name}</span>
                            <div className="flex space-x-2">
                              <StatusBadge 
                                label="Map Loaded" 
                                active={client.status.loaded}
                              />
                              <StatusBadge 
                                label="Logged In" 
                                active={client.status.logged}
                              />
                              <StatusBadge 
                                label="Script Running" 
                                active={client.status.scriptRunning}
                              />
                            </div>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="text-sm text-muted-foreground">
                            <strong>Loaded Script:</strong> {client.status.loadedScript || 'None'}
                          </div>
                        </CardContent>
                      </Card>

                      {/* Client Logs */}
                      <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center space-x-2">
                            <MessageSquare className="w-5 h-5" />
                            <span>Client Logs</span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ScrollArea className="h-64 w-full rounded-md border p-4 bg-muted/20">
                            <div 
                              ref={el => { if (el) clientLogRefs.current[id] = el; }}
                              className="space-y-1"
                            >
                              {client.logs.map((log, index) => (
                                <div 
                                  key={index} 
                                  className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  {log}
                                </div>
                              ))}
                            </div>
                          </ScrollArea>

                          {/* Message Input */}
                          <div className="flex space-x-2 mt-4">
                            <Input
                              placeholder="Send command to client..."
                              value={messageInput}
                              onChange={(e) => setMessageInput(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                              className="flex-1"
                            />
                            <Button onClick={sendMessage} size="sm">
                              <Send className="w-4 h-4" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </TabsContent>
                  ))}
                </Tabs>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Master Log */}
        <div className="space-y-4">
          <Card className="animate-slide-up">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Zap className="w-5 h-5" />
                  <span>Master Log</span>
                </div>
                <Button 
                  onClick={clearMasterLog} 
                  size="sm" 
                  variant="outline"
                  className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-96 w-full rounded-md border p-4 bg-muted/20">
                <div 
                  ref={masterLogRef}
                  className="space-y-1"
                >
                  {state.masterLogs.map((log, index) => (
                    <div 
                      key={index} 
                      className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {log}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};
