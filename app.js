// Import required dependencies
const express = require('express');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Initialize express application
const app = express();
const port = process.env.PORT || 3000;

// Environment variables configuration with default values for development
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/";
const dbName = process.env.DB_NAME || "WhatsApp";
const collectionName = process.env.COLLECTION_NAME || "messages";
/**
 * UPDATE YOUR VERIFY TOKEN
 * This will be the Verify Token value when you set up the webhook
**/
const whatsappApiVersion = process.env.WHATSAPP_API_VERSION || "v15.0";

// Initialize MongoDB client
const client = new MongoClient(mongoUri);

// Middleware to parse JSON bodies
app.use(express.json());

// MongoDB connection function with error handling
async function connectToMongo() {
  try {
    await client.connect();
    console.log("Connected to MongoDB successfully!");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1); // Exit if we can't connect to database
  }
}

// Helper function to get MongoDB collection
function getCollection() {
  return client.db(dbName).collection(collectionName);
}

/** 
 * Webhook verification endpoint (GET)
 * This endpoint accepts GET requests at the /webhook endpoint. You need this URL to set up the webhook initially, refer to the guide https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
**/
app.get('/webhook', (req, res) => {
  // Parse params from the webhook verification request
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];

  // Check the mode and token sent are correct
  if (mode === 'subscribe' && token === verifyToken) {
    // Respond with 200 OK and challenge token from the request
    res.status(200).send(challenge);
  } else {
    // Responds with '403 Forbidden' if verify tokens do not match
    res.sendStatus(403);
  }
});

/** 
 * Webhook events endpoint (POST) 
 * Accepts POST requests at the /webhook endpoint, and this will trigger when a new message is received or message status changes, refer to the guide https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
*/
app.post('/webhook', async (req, res) => {
  try {
    const collection = getCollection();
    
    if (req.body.object && req.body.entry) {
      for (const entry of req.body.entry) {
        for (const change of entry.changes) {
          // Handle message status updates
          if (change.field === "messages" && change.value.statuses) {
            for (const status of change.value.statuses) {
              // Update the status of a message
              await collection.updateOne(
                { messageId: status.id },
                {
                  $set: {
                    status: status.status,
                    updatedAt: new Date(parseInt(status.timestamp) * 1000)
                  }
                }
              );
            }
          }
          // Received message notification
          else if (change.field === "messages" && change.value.messages) {
            for (const message of change.value.messages) {
              const status = message.errors ? "failed" : "ok";
              
              // Insert the received message
              await collection.insertOne({
                type: "received", // this is we received a message from the user
                messageId: message.id, // message id that is from the received message object
                contact: message.from, // user's phone number included country code
                businessPhoneId: change.value.metadata.phone_number_id, // WhatsApp Business Phone ID
                message: message, // message content whatever we received from the user
                status: status, // is the message ok or has an error
                createdAt: new Date(parseInt(message.timestamp) * 1000) // created date
              });
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.sendStatus(500);
  }
});

/**
 * Send message endpoint (POST) 
 * Accepts POST requests at the /send_message endpoint, and this will allow you to send messages the same as documentation https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
*/
app.post('/send_message', async (req, res) => {
  try {
    // Business phone ID is required
    const businessPhoneId = req.query.businessPhoneId;
    if (!businessPhoneId) {
      return res.status(400).json({
        message: "businessPhoneId is required in query params!"
      });
    }

    const collection = getCollection();
      
    // Prepare WhatsApp API URL
    const whatsappUrl = `https://graph.facebook.com/${whatsappApiVersion}/${businessPhoneId}/messages`;

    // Send message to WhatsApp using fetch
    const response = await fetch(whatsappUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization
      },
      body: JSON.stringify(req.body)
    });

    const responseData = await response.json();

    if (response.ok) {
      // Store message in MongoDB if WhatsApp API call was successful
      await collection.insertOne({
        type: "sent", // this is we sent a message from our WhatsApp business account to the user
        messageId: responseData.messages[0].id,  // message id that is from the received message object
        contact: req.body.to, // user's phone number included country code
        businessPhoneId: businessPhoneId, // WhatsApp Business Phone ID
        message: req.body, // message content whatever we received from the user
        status: "initiated", // default status
        createdAt: new Date() // created date
      });
    }

    // Return the WhatsApp API response to the client
    res.status(response.status).json(responseData);
      
  } catch (error) {
    console.error("Error in send_message endpoint:", error);
    res.status(500).json({
      error: "Failed to send message",
      details: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Something went wrong!',
    details: err.message
  });
});

// Start server and connect to MongoDB
async function startServer() {
  await connectToMongo();
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

startServer().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await client.close();
  process.exit(0);
});