import './App.css';
import { useSession, useSupabaseClient, useSessionContext } from '@supabase/auth-helpers-react';
import { useState, useEffect } from 'react';
import { Container, Box, Typography, Button, TextField, IconButton } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { GoogleGenAI, Type } from "@google/genai";

// Constants
const SYSTEM_PROMPT_TEXT = (now) => `You are an A.I Calendar Companion. The user can talk to you and you have the ability to create and delete google calendar events. Every time the user wants to create an event you need to call the createEvent function. Use any information that the user provides as parameters and fill a description based on the context. If no date is given try to set a date and duration that is most apropriate based on the context. The current date is ${now}. The time always has to be in this format 2015-05-28T17:00:00-00:00 (only used as an example). Always to fill To delete an event you have to use the getEvents function that will give you an array of the 20 upcoming events. In each array index will be another array containing the start and end date, eventId, location and title of an event. Navigate the data and use the deleteEvent function to delete the event. If no events match the description of the user input then return a message informing the user. After you finish running the functions return a brief message about the output like event has been created with the event information of event with the eventID has been deleted.`;

// Gemini Function Declarations
const createEventFunctionDeclaration = {
  name: 'createCalendarEvent',
  description: 'Creates a google calendar event and inserts it to primary calendar',
  parameters: {
    type: Type.OBJECT,
    properties: {
      eventName: {
        type: Type.STRING,
        description: 'Name of the event'
      },
      eventDescription: {
        type: Type.STRING,
        description: 'Description of the event'
      },
      location: {
        type: Type.STRING,
        description: 'location of the event'
      },
      starttime: {
        type: Type.STRING,
        description: 'Starting time of the event in this format 2015-05-28T17:00:00-00:00'
      },
      endtime: {
        type: Type.STRING,
        description: 'Ending time of the event in this format 2015-05-28T17:00:00-00:00'
      }
    }
  }
};

const deleteEventFunctionDeclaration = {
  name: 'deleteCalendarEvent',
  description: 'Deletes a google calendar event from primary calendar',
  parameters: {
    type: Type.OBJECT,
    properties: {
      eventId: {
        type: Type.STRING,
        description: 'Event identifier'
      }
    }
  }
};

const getEventsFunctionDeclaration = {
  name: 'getEvents',
  description: 'Gets calendar events',
  parameters: {
    type: Type.OBJECT 
  }
};

const TypingIndicator = () => (
  <Box sx={{ display: 'inline-flex', alignItems: 'center', height: '24px' }}>
    {[0, 200, 400].map((delay) => (
      <Box 
        key={delay}
        sx={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: 'text.secondary',
          marginRight: '4px',
          animation: 'pulse 1s infinite',
          animationDelay: `${delay}ms`,
          '@keyframes pulse': {
            '0%, 100%': { opacity: 0.5, transform: 'scale(0.9)' },
            '50%': { opacity: 1, transform: 'scale(1.1)' }
          }
        }}
      />
    ))}
  </Box>
);

function App() {
  // State
  const now = new Date().toISOString();
  const session = useSession();
  const supabase = useSupabaseClient();
  const { isLoading } = useSessionContext();
  const [messages, setMessages] = useState([
    { text: "Hello! I'm your Calendar Assistant. How can I help you today?", sender: "bot" }
  ]);
  const [message, setMessage] = useState('');
  const [currentChatId, setCurrentChatId] = useState(null);
  const [availableChats, setAvailableChats] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [history, setHistory] = useState([{
    role: 'user',
    parts: [{ text: SYSTEM_PROMPT_TEXT(now) }],
    metadata: { isSystemPrompt: true }
  }]);

  // AI Configuration
  const ai = new GoogleGenAI({ apiKey: 'AIzaSyC-ApW6noBeITYkZwnLyOjJf6aGQAlakq0' });
  const model = 'gemini-2.0-flash';

  // Load chats when session changes
  useEffect(() => {
    const initializeChats = async () => {
      if (session?.user?.id) {
        try {
          await ensureBucketExists();
          const chats = await loadAllChats(session.user.id);
          setAvailableChats(chats);

          if (chats.length > 0) {
            if (!currentChatId) {
              await loadChat(chats[0].id);
            } else {
              const chatExists = chats.some(chat => chat.id === currentChatId);
              if (!chatExists) {
                await loadChat(chats[0].id);
              }
            }
          } else {
            await handleNewChat();
          }
        } catch (error) {
          console.error('Initialization error:', error);
          await handleNewChat();
        }
      } else {
        setAvailableChats([]);
        setCurrentChatId(null);
      }
    };

    initializeChats();
  }, [session]);


  // Helper Functions
  const getChatFilePath = (userId, chatId) => `user-${userId}/chat-${chatId}.json`;

  // Ensure bucket exists
  const ensureBucketExists = async () => {
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      if (listError) throw listError;
      
      const bucketExists = buckets.some(b => b.name === 'chats');
      
      if (!bucketExists) {
        const { error: createError } = await supabase.storage.createBucket('chats', {
          public: false,
          allowedMimeTypes: ['application/json']
        });
        
        if (createError) throw createError;
        await addBucketPolicy();
      }
    } catch (error) {
      console.error('Bucket initialization error:', error);
    }
  };


  const addBucketPolicy = async () => {
    try {
      const { error } = await supabase.rpc('create_storage_policy');
      
      if (error) {
        console.warn('Failed to create storage policy:', error);
        // Fallback to direct SQL if RPC doesn't exist
        await supabase.rpc(`
          create policy "Allow authenticated access to chats bucket"
          on storage.objects
          for all
          using (bucket_id = 'chats' AND auth.role() = 'authenticated');
        `);
      }
    } catch (policyError) {
      console.error('Policy creation error:', policyError);
    }
  };

  // Auth Functions
  async function googleSignIn() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'https://www.googleapis.com/auth/calendar'
      }
    });
    if (error) {
      alert('Error signing in');
      console.log(error);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setAvailableChats([]);
    setCurrentChatId(null);
    setMessages([
      { text: "Hello! I'm your Calendar Assistant. How can I help you today?", sender: "bot" }
    ]);
  }

  // Chat Stuff
  const handleNewChat = async () => {
    if (!session) return;
    
    const newChatId = crypto.randomUUID();
    setCurrentChatId(newChatId);
    
    // Create New History 
    const newHistory = [
      {
        role: 'user',
        parts: [{ text: SYSTEM_PROMPT_TEXT(new Date().toISOString()) }],
        metadata: { isSystemPrompt: true }
      },
      {
        role: 'model',
        parts: [{ text: "New chat started. How can I help you with your calendar today?" }]
      }
    ];
    
    setHistory(newHistory);
    setMessages([
      { text: "New chat started. How can I help you with your calendar today?", sender: "bot" }
    ]);
    
    // Add to available chats
    setAvailableChats(prev => [
      {
        id: newChatId,
        name: `Chat ${new Date().toLocaleString()}`,
        lastUpdated: new Date().toISOString()
      },
      ...prev
    ]);
  
    await saveChatHistory(session.user.id, newChatId, newHistory);
  };

  const loadChat = async (chatId) => {
    if (!session?.user?.id || !chatId) return;
  
    try {
      const filePath = getChatFilePath(session.user.id, chatId);
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('chats')
        .download(filePath);
  
      if (downloadError) {
        if (downloadError.message.includes('not found')) {
          return await handleNewChat();
        }
        throw downloadError;
      }
  
      const content = await fileData.text();
      let chatHistory;
      
      try {
        chatHistory = JSON.parse(content);
        if (!Array.isArray(chatHistory)) {
          throw new Error('Invalid chat format');
        }
      } catch (parseError) {
        console.error('Error parsing chat:', parseError);
        return await handleNewChat();
      }
  
      // Set the full history including system prompt
      setCurrentChatId(chatId);
      setHistory(chatHistory);
  
      // Filter out system prompts and convert to display messages
      const displayMessages = chatHistory
        .filter(item => {
          // Skip items without parts or text
          if (!item.parts || !item.parts[0]?.text) return false;
          // Skip system prompts (either marked with metadata or containing the system prompt text)
          return !(item.metadata?.isSystemPrompt || item.parts[0].text.includes('You are an A.I Calendar Companion'));
        })
        .map(item => ({
          text: item.parts[0].text,
          sender: item.role === 'user' ? 'user' : 'bot'
        }));
  
      // If no messages, show default message
      setMessages(displayMessages.length > 0 
        ? displayMessages 
        : [{ text: "Chat loaded. How can I help you today?", sender: "bot" }]
      );
  
    } catch (error) {
      console.error('Error loading chat:', error);
      await handleNewChat();
    }
  };


  const loadAllChats = async (userId) => {
    if (!userId) return [];
  
    try {
      // List all files in the user's folder
      const { data: files, error } = await supabase
        .storage
        .from('chats')
        .list(`user-${userId}/`, {
          limit: 100,  // Increase limit to ensure we get all chats
          offset: 0,
          sortBy: { column: 'created_at', order: 'desc' }
        });

      if (error) throw error;
      if (!files) return [];

      // Process only JSON files and extract metadata
      const chatList = files
        .filter(file => file.name.startsWith('chat-') && file.name.endsWith('.json'))
        .map(file => {
          const chatId = file.name.replace('chat-', '').replace('.json', '');
          return {
            id: chatId,
            name: `Chat ${new Date(file.created_at).toLocaleString()}`,
            lastUpdated: file.created_at
          };
        });

      return chatList;
    } catch (error) {
      console.error('Error loading chat list:', error);
      return [];
    }
  };

  // Storage Functions
  const saveChatHistory = async (userId, chatId, history) => {
    try {
      const filePath = getChatFilePath(userId, chatId);
      
      // Convert history to JSON string
      const fileContent = JSON.stringify(history);
      
      // Create a File object
      const file = new File([fileContent], `chat-${chatId}.json`, {
        type: 'application/json'
      });

      // First try to upload
      let { error } = await supabase.storage
        .from('chats')
        .upload(filePath, file, {
          upsert: true,
          cacheControl: '3600',
          contentType: 'application/json'
        });

      // If upload fails because file exists, try update
      if (error && error.message.includes('already exists')) {
        const { error: updateError } = await supabase.storage
          .from('chats')
          .update(filePath, file, {
            cacheControl: '3600',
            contentType: 'application/json'
          });
        error = updateError;
      }

      if (error) throw error;

      // Refresh the chat list
      const updatedChats = await loadAllChats(userId);
      setAvailableChats(updatedChats);

      return true;
    } catch (error) {
      console.error('Detailed save error:', error);
      return false;
    }
  };

  // Message Handling
/*  const animateTyping = (fullText) => {
    let i = 0;
    const typingInterval = setInterval(() => {
      setMessages(prev => {
        const newMessages = [...prev];
        const lastMessage = newMessages[newMessages.length - 1];
        
        if (lastMessage?.sender === "bot") {
          lastMessage.text = fullText.substring(0, i);
          i++;
          
          if (i > fullText.length) {
            clearInterval(typingInterval);
            setIsTyping(false);
            lastMessage.isTyping = false;
          }
        }
        return newMessages;
      });
    }, 20);
  };
*/


  const handleSend = async () => {
    if (!message.trim() || isTyping || !session || !currentChatId) return;

    // Add user message
    const userMessage = { text: message, sender: "user" };
    setMessages(prev => [...prev, userMessage]);
    const updatedHistory = [...history, { 
      role: 'user', 
      parts: [{ text: message }] 
    }];
    setHistory(updatedHistory);
    setMessage('');
    
    // Save immediately
    const saveSuccess = await saveChatHistory(
      session.user.id, 
      currentChatId, 
      updatedHistory
    );
    
    if (!saveSuccess) {
      setMessages(prev => [...prev, { 
        text: "Error saving message", 
        sender: "bot" 
      }]);
      return;
    }

    // Typing indicator
    setIsTyping(true);
    setMessages(prev => [...prev, { text: '', sender: "bot", isTyping: true }]);

    // Get AI response
    const answer = await generateAI(message, updatedHistory);
    
    // Update with AI response
    const finalHistory = [...updatedHistory, { 
      role: 'model', 
      parts: [{ text: answer }] 
    }];
    setHistory(finalHistory);
    
    // Update messages
    setMessages(prev => {
      const newMessages = prev.filter(m => !m.isTyping);
      return [...newMessages, { text: answer, sender: "bot" }];
    });
    
    // Final save
    await saveChatHistory(session.user.id, currentChatId, finalHistory);
    setIsTyping(false);
  };

  const handleChatClick = async (chatId) => {
    // Create new chat if clicking on the "New Chat" button
    if (chatId === 'new') {
      await handleNewChat();
      return;
    }

    await loadChat(chatId);
  };

  // AI Functions
  async function generateAI(input, currentHistory) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: currentHistory,
        config: {
          tools: [{
            functionDeclarations: [
              createEventFunctionDeclaration,
              deleteEventFunctionDeclaration,
              getEventsFunctionDeclaration
            ]
          }]
        }
      });

      // Handle function calls
      if (response.functionCalls && response.functionCalls.length > 0) {
        const functionCall = response.functionCalls[0];
        
        let result;
        switch (functionCall.name) {
          case 'createCalendarEvent':
            result = await createCalendarEvent(
              functionCall.args.eventName,
              functionCall.args.eventDescription,
              functionCall.args.location,
              functionCall.args.starttime,
              functionCall.args.endtime
            );
            if (result && result.summary) {
              return `Event "${result.summary}" created successfully!`;
            }
            break;
            
          case 'deleteCalendarEvent':
            result = await deleteCalendarEvent(functionCall.args.eventId);
            return result ? "Event deleted successfully." : "Failed to delete event.";
            
          case 'getEvents':
            result = await getEvents();
            return result;
            
          default:
            result = "Unknown function requested";
        } 
        return typeof result === 'string' ? result : JSON.stringify(result);
      }

      return response.text || "I couldn't generate a response.";
    } catch (error) {
      console.error('AI error:', error);
      return "Sorry, I encountered an error.";
    }
  }

  // Calendar Functions
  async function createCalendarEvent(eventName, eventDescription, location, starttime, endtime) {
    if (!session?.provider_token) {
      alert('Please sign in with Google first');
      return;
    }
  
    const event = {
      'summary': eventName,
      'description': eventDescription || 'No description provided',
      'location': location || '',
      'start': {
        'dateTime': starttime,
        'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      'end': {
        'dateTime': endtime,
        'timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    };
  
    try {
      const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + session.provider_token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event)
      });
  
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Failed to create event');
      return data;
    } catch (error) {
      console.error('Error creating event:', error);
      return null;
    }
  }

  const renderMessageContent = (msg) => {
    return (
      <Box component="div" sx={styles.messageText}>
        {msg.text}
        {msg.isTyping && <TypingIndicator />}
      </Box>
    );
  };

  async function deleteCalendarEvent(eventId) {
    try {
      const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.provider_token}`
        }
      });
  
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || 'Failed to delete event');
      }
      return true;
    } catch (error) {
      console.error('Error deleting event:', error);
      return false;
    }
  }

  async function getEvents() {
    if (!session?.provider_token) {
      return "🔒 Please sign in with Google first";
    }
  
    try {
      const now = new Date().toISOString();
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `maxResults=10&orderBy=startTime&singleEvents=true&timeMin=${now}`,
        {
          headers: {
            'Authorization': 'Bearer ' + session.provider_token
          }
        }
      );
  
      const data = await response.json();
      if (!data.items || data.items.length === 0) {
        return "📅 No upcoming events found";
      }
  
      return data.items.map((event, index) => {
        const startDate = event.start.dateTime 
          ? new Date(event.start.dateTime).toLocaleString() 
          : new Date(event.start.date).toLocaleDateString();
        
        const endDate = event.end.dateTime 
          ? new Date(event.end.dateTime).toLocaleString() 
          : new Date(event.end.date).toLocaleDateString();
  
        return `\n${index + 1}. ${event.summary || 'Untitled Event'}
     🕒 ${startDate} - ${endDate}
     📍 ${event.location || 'No location'}`;
      }).join('\n');
    } catch (error) {
      console.error('Error fetching events:', error);
      return "❌ Error fetching events";
    }
  }

  if (isLoading) return <></>;

  return (
    <Container maxWidth={false} sx={styles.container}>
      {/* Sidebar */}
      <Box sx={styles.sidebar}>
        <Typography variant="h6" sx={styles.title}>Calendar A.I</Typography>
        
        <Button 
          variant="contained"
          onClick={() => handleChatClick('new')}
          sx={styles.newChatButton}
        >
          + New Chat
        </Button>

        <Box sx={styles.chatList}>
          {availableChats.map(chat => (
            <Box 
              key={chat.id}
              onClick={() => handleChatClick(chat.id)}
              sx={{
                ...styles.chatItem,
                backgroundColor: currentChatId === chat.id ? '#f0f0f0' : 'transparent',
                borderLeft: currentChatId === chat.id ? '4px solid #1976d2' : '4px solid transparent'
              }}
            >
              <Typography sx={{ 
                fontWeight: 'bold', 
                whiteSpace: 'nowrap', 
                overflow: 'hidden', 
                textOverflow: 'ellipsis' 
              }}>
                {chat.name}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {new Date(chat.lastUpdated).toLocaleDateString()}
              </Typography>
            </Box>
          ))}
        </Box>

        <Box sx={styles.authContainer}>
          {session ? (
            <Button variant="outlined" onClick={signOut} sx={styles.authButton}>
              Sign Out
            </Button>
          ) : (
            <Button variant="contained" onClick={googleSignIn} sx={styles.authButton}>
              Sign In with Google
            </Button>
          )}
        </Box>
      </Box>

      {/* Main Chat Area */}
      <Box sx={styles.chatArea}>
        <Box sx={styles.messagesContainer}>
          {messages.map((msg, index) => (
            <Box key={index} sx={styles.messageBox}>
              <Typography variant="subtitle2" sx={styles.sender(msg.sender)}>
                {msg.sender === 'user' ? 'YOU' : 'A.I Companion'}
              </Typography>
              {renderMessageContent(msg)}
            </Box>
          ))}
        </Box>

        <Box sx={styles.inputContainer}>
          <TextField
            fullWidth
            variant="outlined"
            placeholder="What's in your mind?..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            sx={styles.inputField}
            InputProps={{
              endAdornment: (
                <IconButton 
                  color="primary" 
                  onClick={handleSend}
                  disabled={!message.trim() || !session?.provider_token}
                  sx={{ mr: -1 }}
                >
                  <SendIcon />
                </IconButton>
              ),
            }}
          />
        </Box>
      </Box>
    </Container>
  );
} 

// Styles
const styles = {
  container: {
    height: '100vh',
    backgroundColor: 'rgb(243,247,251)',
    padding: 0,
    margin: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  sidebar: {
    width: '17%',
    height: 'calc(100% - 32px)',
    backgroundColor: 'white',
    borderRadius: '32px',
    position: 'absolute',
    left: '16px',
    top: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '0px',
    boxSizing: 'border-box',
    zIndex: 1,
  },
  title: {
    fontFamily: '"Calibri", Arial, sans-serif',
    fontSize: '1.5rem',
    paddingTop: '16px',
    marginBottom: '24px',
    fontWeight: '0px'
  },
  newChatButton: {
    width: '90%',
    borderRadius: '24px',
    margin: '16px auto',
    textTransform: 'none',
    backgroundColor: '#1976d2',
    '&:hover': {
      backgroundColor: '#1565c0'
    }
  },
  chatList: {
    flex: 1,
    width: '100%',
    overflowY: 'auto',
    padding: '0px'
  },
  chatItem: {
    padding: '12px 24px',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    '&:hover': { 
      backgroundColor: '#f5f5f5' 
    }
  },
  authContainer: {
    width: '100%',
    padding: '16px 0',
    display: 'flex',
    justifyContent: 'center'
  },
  authButton: {
    width: '90%',
    borderRadius: '24px',
    padding: '8px',
    textTransform: 'none',
    fontSize: '1rem'
  },
  chatArea: {
    position: 'absolute',
    left: '332px',
    right: '16px',
    top: '16px',
    bottom: '16px',
    backgroundColor: 'transparent',
    borderRadius: '16px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  messagesContainer: {
    flex: 1,
    overflow: 'auto',
    padding: '16px 15%',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px'
  },
  messageBox: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column'
  },
  sender: (sender) => ({
    fontWeight: 'bold',
    color: sender === 'user' ? 'primary.main' : 'text.secondary',
    mb: 1
  }),
  messageText: {
    color: 'text.primary',
    whiteSpace: 'pre-wrap',
    lineHeight: 1.6,
    minHeight: '24px'
  },
  inputContainer: {
    padding: '16px',
    display: 'flex',
    justifyContent: 'center',
    backgroundColor: 'transparent'
  },
  inputField: {
    maxWidth: '800px',
    '& .MuiOutlinedInput-root': {
      borderRadius: '29px',
      backgroundColor: 'white',
      overflow: 'hidden',
      paddingLeft: '16px',
      paddingRight: '8px',
      '& fieldset': { borderColor: 'transparent' },
      '&:hover fieldset': { borderColor: 'transparent' },
      '&.Mui-focused fieldset': {
        borderColor: 'primary.main',
        boxShadow: '0 0 0 2px rgba(25, 118, 210, 0.2)'
      },
      '& .MuiOutlinedInput-input': { padding: '12px 0' },
    },
  }
};

export default App;