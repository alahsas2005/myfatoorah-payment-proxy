const express = require('express');
const app = express();

// Node.js 18+ has built-in fetch, no need for node-fetch

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Configuration
const MYFATOORAH_API_TOKEN = process.env.MYFATOORAH_API_TOKEN || '';
const MYFATOORAH_API_URL = 'https://api.myfatoorah.com/v2/SendPayment';
const MYFATOORAH_GET_PAYMENT_URL = 'https://api.myfatoorah.com/v2/GetPaymentStatus';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'techgamingworlds.myshopify.com';
const VERIFICATION_PAGE_URL = `https://${SHOPIFY_STORE}/pages/payment-verification`;

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MyFatoorah Payment Proxy - Ultimate Smart Button',
    version: '8.0-DRAFT-ORDERS-TRACKING',
    endpoints: {
      createPayment: 'POST /api/create-payment',
      createDraftOrder: 'POST /api/create-draft-order',
      verifyPayment: 'GET /api/verify-payment',
      webhook: 'POST /api/webhook'
    }
  });
});

// Create Draft Order (for tracking checkout initiation)
app.post('/api/create-draft-order', async (req, res) => {
  try {
    const { variantId, quantity, customerEmail, customerPhone, productTitle, price } = req.body;

    console.log('📝 Creating Draft Order:', JSON.stringify(req.body, null, 2));

    if (!SHOPIFY_ACCESS_TOKEN) {
      return res.status(500).json({
        success: false,
        error: 'Shopify access token not configured'
      });
    }

    // Create draft order
    const draftOrderData = {
      draft_order: {
        line_items: [
          {
            variant_id: parseInt(variantId),
            quantity: quantity || 1
          }
        ],
        customer: {
          email: customerEmail
        },
        email: customerEmail,
        note: `MyFatoorah Express Checkout - Initiated at ${new Date().toISOString()}`,
        tags: 'myfatoorah-draft, express-checkout-initiated',
        use_customer_default_address: false
      }
    };

    // Add phone if provided
    if (customerPhone) {
      draftOrderData.draft_order.customer.phone = customerPhone;
    }

    const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/draft_orders.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(draftOrderData)
    });

    const result = await response.json();

    if (result.draft_order) {
      console.log('✅ Draft Order Created:', result.draft_order.id);
      return res.json({
        success: true,
        draftOrderId: result.draft_order.id,
        draftOrderName: result.draft_order.name
      });
    } else {
      console.error('❌ Failed to create draft order:', result);
      return res.status(400).json({
        success: false,
        error: result.errors || 'Failed to create draft order'
      });
    }
  } catch (error) {
    console.error('❌ Draft Order Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Create Payment
app.post('/api/create-payment', async (req, res) => {
  try {
    const { productId, variantId, productTitle, quantity, price, customerEmail, customerPhone } = req.body;

    console.log('📥 Request body from Shopify:', JSON.stringify(req.body, null, 2));

    // Validate required fields
    if (!price || parseFloat(price) <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid price' 
      });
    }
    
    const finalEmail = customerEmail || 'guest@techgamingworlds.com';
    let finalPhone = customerPhone ? customerPhone.replace(/[^0-9]/g, '').substring(0, 11) : null;
    
    // Prepare payment request
    const paymentData = {
      InvoiceValue: parseFloat(price),
      CustomerName: 'Guest Customer',
      DisplayCurrencyIso: 'AED',
      Language: 'ar',
      CustomerEmail: finalEmail,
      NotificationOption: 'LNK',
      CallBackUrl: `${VERIFICATION_PAGE_URL}`,
      ErrorUrl: `${VERIFICATION_PAGE_URL}`,
      InvoiceItems: [
        {
          ItemName: productTitle || 'Product Purchase',
          Quantity: quantity,
          UnitPrice: parseFloat(price) / quantity
        }
      ],
      UserDefinedField: JSON.stringify({
        productId,
        variantId,
        productTitle,
        quantity,
        customerEmail: finalEmail,
        customerPhone: finalPhone,
        source: 'express_checkout',
        draftOrderId: draftOrderId
      })
    };
    
    // Only add CustomerMobile if it's not null or empty
    if (finalPhone && finalPhone.length > 0) {
      paymentData.CustomerMobile = finalPhone;
    }
    
    console.log('📤 Data sent to MyFatoorah:', JSON.stringify(paymentData, null, 2));
    
    // Store draft order ID if provided
    let draftOrderId = req.body.draftOrderId || null;
    
    // Call MyFatoorah API
    const response = await fetch(MYFATOORAH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MYFATOORAH_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentData)
    });

    let data;
    try {
      data = await response.json();
    } catch (jsonError) {
      console.error('❌ MyFatoorah Response is not valid JSON. Raw text: Could not read body to prevent error.');
      return res.status(500).json({
        success: false,
        error: 'MyFatoorah returned invalid response'
      });
    }

    console.log('📨 MyFatoorah Response:', JSON.stringify(data, null, 2));

    if (data.IsSuccess && data.Data && data.Data.InvoiceURL) {
      return res.json({
        success: true,
        paymentUrl: data.Data.InvoiceURL,
        invoiceId: data.Data.InvoiceId,
        paymentId: data.Data.PaymentId || data.Data.InvoiceId
      });
    } else {
      return res.status(400).json({
        success: false,
        error: data.Message || 'Failed to create payment'
      });
    }

  } catch (error) {
    console.error('❌ Server Error (Full):', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Verify Payment and Create Shopify Order
app.get('/api/verify-payment', async (req, res) => {
  try {
    const { paymentId } = req.query;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        error: 'Payment ID is required'
      });
    }

    console.log('🔍 Verifying payment:', paymentId);

    // Get payment status from MyFatoorah
    const response = await fetch(MYFATOORAH_GET_PAYMENT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MYFATOORAH_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        Key: paymentId,
        KeyType: 'PaymentId'
      })
    });

    const data = await response.json();
    console.log('📨 Payment Status:', JSON.stringify(data, null, 2));

    if (!data.IsSuccess) {
      return res.json({
        success: false,
        status: 'failed',
        message: data.Message || 'Payment verification failed'
      });
    }

    const paymentStatus = data.Data.InvoiceStatus;
    const isPaid = paymentStatus === 'Paid';

    if (isPaid) {
      // Parse callback data
      let callbackData = {};
      try {
        if (data.Data.UserDefinedField) {
          callbackData = JSON.parse(data.Data.UserDefinedField);
        }
      } catch (e) {
        console.error('Failed to parse callback data:', e);
      }

      // Create Shopify Order
      let orderData = null;
      if (SHOPIFY_ACCESS_TOKEN && callbackData.variantId) {
        try {
          orderData = await createShopifyOrder(data.Data, callbackData);
        } catch (orderError) {
          console.error('Failed to create Shopify order:', orderError);
        }
      }

      return res.json({
        success: true,
        status: 'paid',
        amount: data.Data.InvoiceValue,
        currency: data.Data.Currency,
        orderId: orderData?.id || null,
        orderNumber: orderData?.order_number || null,
        orderUrl: orderData?.order_status_url || null,
        invoiceId: data.Data.InvoiceId,
        transactionId: data.Data.InvoiceTransactions[0]?.TransactionId
      });
    } else if (paymentStatus === 'Pending') {
      return res.json({
        success: false,
        status: 'pending',
        message: 'Payment is still pending'
      });
    } else {
      return res.json({
        success: false,
        status: 'failed',
        message: 'Payment was not completed'
      });
    }

  } catch (error) {
    console.error('❌ Verification Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Create Shopify Order
async function createShopifyOrder(paymentData, callbackData) {
  try {
    const customerEmail = callbackData.customerEmail || paymentData.CustomerEmail;
    
    // Search for existing customer by email
    let customerId = null;
    try {
      const searchResponse = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/customers/search.json?query=email:${encodeURIComponent(customerEmail)}`, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      const searchResult = await searchResponse.json();
      if (searchResult.customers && searchResult.customers.length > 0) {
        customerId = searchResult.customers[0].id;
        console.log('✅ Found existing customer:', customerId);
      }
    } catch (searchError) {
      console.log('⚠️ Customer search failed, will create new:', searchError.message);
    }

    const orderData = {
      order: {
        email: customerEmail,
        financial_status: 'paid',
        send_receipt: true,
        send_fulfillment_receipt: true,
        line_items: [
          {
            variant_id: parseInt(callbackData.variantId),
            quantity: callbackData.quantity || 1
          }
        ],
        transactions: [
          {
            kind: 'sale',
            status: 'success',
            amount: paymentData.InvoiceValue,
            gateway: 'MyFatoorah',
            authorization: paymentData.InvoiceId
          }
        ],
        note: `Paid via MyFatoorah - Invoice ID: ${paymentData.InvoiceId}`,
        tags: 'myfatoorah, express-checkout'
      }
    };
    
    // Add customer_id if found, otherwise add customer email only (no phone to avoid conflicts)
    if (customerId) {
      orderData.order.customer = { id: customerId };
    } else {
      orderData.order.customer = {
        email: customerEmail
      };
    }

    const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderData)
    });

    const result = await response.json();
    
    if (result.order) {
      console.log('✅ Shopify Order Created:', result.order.id);
      return {
        id: result.order.id,
        order_number: result.order.order_number,
        order_status_url: result.order.order_status_url
      };
    } else {
      console.error('❌ Failed to create Shopify order:', result);
      return null;
    }
  } catch (error) {
    console.error('❌ Shopify Order Creation Error:', error);
    return null;
  }
}

// MyFatoorah Webhook (for real-time updates)
app.post('/api/webhook', async (req, res) => {
  try {
    console.log('📨 MyFatoorah Webhook Received:', JSON.stringify(req.body, null, 2));
    
    // Process webhook data
    const { Data, EventType } = req.body;
    
    // Respond immediately to MyFatoorah
    res.status(200).json({ success: true, message: 'Webhook received' });
    
    // Process webhook asynchronously
    if (Data && EventType === 'TransactionStatusChanged' && Data.InvoiceStatus === 'Paid') {
      console.log('✅ Payment confirmed via webhook:', Data.InvoiceId);
      
      // Parse UserDefinedField to get order details
      let callbackData = {};
      try {
        if (Data.UserDefinedField) {
          callbackData = JSON.parse(Data.UserDefinedField);
          console.log('📦 Parsed callback data:', callbackData);
        }
      } catch (e) {
        console.error('❌ Failed to parse UserDefinedField:', e);
      }
      
      // Delete Draft Order if exists
      if (SHOPIFY_ACCESS_TOKEN && callbackData.draftOrderId) {
        try {
          console.log('🗑️ Deleting Draft Order:', callbackData.draftOrderId);
          await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/draft_orders/${callbackData.draftOrderId}.json`, {
            method: 'DELETE',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
          });
          console.log('✅ Draft Order deleted successfully');
        } catch (deleteError) {
          console.error('❌ Failed to delete draft order:', deleteError);
        }
      }
      
      // Create Shopify Order if we have the necessary data
      if (SHOPIFY_ACCESS_TOKEN && callbackData.variantId) {
        try {
          console.log('🛍️ Creating Shopify order from webhook...');
          const orderData = await createShopifyOrder(Data, callbackData);
          
          if (orderData) {
            console.log('✅ Shopify Order Created Successfully:', {
              orderId: orderData.id,
              orderNumber: orderData.order_number,
              orderUrl: orderData.order_status_url
            });
          } else {
            console.error('❌ Failed to create Shopify order from webhook');
          }
        } catch (orderError) {
          console.error('❌ Error creating Shopify order from webhook:', orderError);
        }
      } else {
        console.warn('⚠️ Missing required data for Shopify order creation:', {
          hasAccessToken: !!SHOPIFY_ACCESS_TOKEN,
          hasVariantId: !!callbackData.variantId,
          callbackData
        });
      }
    } else {
      console.log('ℹ️ Webhook event not processed:', {
        eventType: EventType,
        invoiceStatus: Data?.InvoiceStatus
      });
    }
  } catch (error) {
    console.error('❌ Webhook Error:', error);
    // Don't send error response as we already responded above
  }
});

// Legacy webhook endpoint (for backward compatibility)
app.post('/api/myfatoorah-webhook', async (req, res) => {
  // Redirect to new endpoint
  req.url = '/api/webhook';
  return app._router.handle(req, res);
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ MyFatoorah Proxy running on port ${PORT}`);
  console.log(`📍 Environment: ${MYFATOORAH_API_URL.includes('apitest') ? 'TEST' : 'PRODUCTION'}`);
});
